import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
const onlineUsers = new Map<string, Set<string>>();
const jwtSecret = process.env.JWT_SECRET;
const uploadDirectory = resolve(process.env.UPLOAD_DIR || "uploads");
mkdirSync(uploadDirectory, { recursive: true });
if (!process.env.DATABASE_URL || !jwtSecret || jwtSecret.length < 32) {
  throw new Error("DATABASE_URL ve en az 32 karakterli JWT_SECRET ortam değişkenleri gereklidir.");
}
const io = new Server(httpServer, { cors: { origin: process.env.CLIENT_ORIGIN || "http://localhost:5173", credentials: true } });
app.disable("x-powered-by");
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: { directives: { imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'", "ws:", "wss:", "https://api.resend.com"], styleSrc: ["'self'", "'unsafe-inline'"] } }
}));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadDirectory, { immutable: true, maxAge: "1d" }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const clientDist = resolve(process.cwd(), "dist");
if (existsSync(clientDist)) app.use(express.static(clientDist));

type AuthRequest = Request & { user?: { id: string; username: string; isAdmin: boolean }; lockedConversationIds?: string[] };
function tokenFor(user: { id: string; username: string; is_admin: boolean; token_version?: number }) {
  return jwt.sign({ sub: user.id, username: user.username, isAdmin: user.is_admin, tokenVersion: user.token_version || 0 }, jwtSecret!, { expiresIn: "7d" });
}
async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Oturum açmanız gerekiyor." });
  try {
    const data = jwt.verify(token, jwtSecret!) as { sub: string; username: string; isAdmin: boolean; tokenVersion?: number };
    if (!data.sub || typeof data.username !== "string") return res.status(401).json({ error: "Oturum geçersiz." });
    const account = await pool.query("SELECT username, is_admin, is_disabled, token_version FROM users WHERE id = $1", [data.sub]);
    if (!account.rowCount || account.rows[0].is_disabled) return res.status(401).json({ error: "Hesap kullanılamıyor. Yeniden giriş yapın." });
    if (account.rows[0].username !== data.username) return res.status(401).json({ error: "Oturum bilgisi değişmiş. Yeniden giriş yapın." });
    if ((data.tokenVersion || 0) !== account.rows[0].token_version) return res.status(401).json({ error: "Oturum sonlandırıldı. Yeniden giriş yapın." });
    req.user = { id: data.sub, username: data.username, isAdmin: account.rows[0].is_admin };
    const lockToken = req.headers["x-chat-unlock"];
    if (typeof lockToken === "string") {
      try {
        const unlocked = jwt.verify(lockToken, jwtSecret!) as { sub: string; purpose: string; conversations: string[] };
        if (unlocked.sub === data.sub && unlocked.purpose === "locked_chats" && Array.isArray(unlocked.conversations)) req.lockedConversationIds = unlocked.conversations;
      } catch {
        return res.status(401).json({ error: "Kilitli sohbet izni geçersiz veya süresi dolmuş." });
      }
    }
    next();
  } catch {
    return res.status(401).json({ error: "Oturum geçersiz veya süresi dolmuş." });
  }
}
async function adminOnly(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Bu işlem için yönetici yetkisi gerekiyor." });
  try {
    const { rowCount } = await pool.query("SELECT 1 FROM users WHERE id = $1 AND is_admin = true AND is_disabled = false", [req.user.id]);
    if (!rowCount) return res.status(403).json({ error: "Yönetici yetkisi bulunamadı." });
    next();
  } catch (error) { next(error); }
}
function normalizedUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^@/, "").toLocaleLowerCase("tr") : "";
}
function validUsername(value: string) {
  return /^[a-z0-9._çğıöşü]{3,24}$/.test(value);
}
function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: message });
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] || "" : value;
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, name.length - 1))}@${domain}`;
}
async function sendEmail(to: string, subject: string, title: string, copy: string, code: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("E-posta servisi yapılandırılmamış. RESEND_API_KEY ve EMAIL_FROM ayarlayın.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [to], subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:32px auto;padding:32px;border:1px solid #e8e9e2;border-radius:16px;color:#24261f"><div style="font-size:14px;font-weight:bold;color:#157f79">ZibZib</div><h1 style="font-size:22px">${escapeHtml(title)}</h1><p style="font-size:14px;line-height:1.6;color:#62645b">${escapeHtml(copy)}</p><div style="margin:24px 0;padding:16px;text-align:center;border-radius:10px;background:#edf5f2;font-size:30px;font-weight:bold;letter-spacing:9px;color:#157f79">${escapeHtml(code)}</div><p style="font-size:12px;color:#898a7e">Bu kod 10 dakika geçerlidir. Kodu kimseyle paylaşma. Bu isteği sen başlatmadıysan bu e-postayı yok say.</p></div>`
    })
  });
  if (!response.ok) {
    console.error("Email delivery failed", response.status, await response.text());
    throw new Error("E-posta gönderilemedi. E-posta ayarlarını kontrol edip tekrar deneyin.");
  }
}
async function createEmailChallenge(userId: string, purpose: "login_2fa" | "password_reset" | "lock_recovery" | "email_change", email: string, username: string) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  await pool.query("DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = $2", [userId, purpose]);
  const { rows } = await pool.query(
    "INSERT INTO auth_challenges (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id",
    [userId, purpose, codeHash]
  );
  try {
    const subject = purpose === "password_reset" ? "Şifre sıfırlama kodun" : purpose === "lock_recovery" ? "Sohbet kilidi kurtarma kodun" : "Giriş doğrulama kodun";
    await sendEmail(email, subject, subject, `Merhaba ${username}, işlemini tamamlamak için bu kodu kullan.`, code);
  } catch (error) {
    await pool.query("DELETE FROM auth_challenges WHERE id = $1", [rows[0].id]);
    throw error;
  }
  return rows[0].id as string;
}
async function consumeEmailChallenge(id: string, userId: string, purpose: "login_2fa" | "password_reset" | "lock_recovery" | "email_change", code: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, code_hash, attempts FROM auth_challenges WHERE id = $1 AND user_id = $2 AND purpose = $3 AND expires_at > now() FOR UPDATE",
      [id, userId, purpose]
    );
    if (!rows.length || rows[0].attempts >= 5) { await client.query("ROLLBACK"); return false; }
    if (!(await bcrypt.compare(code, rows[0].code_hash))) {
      await client.query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1", [id]);
      await client.query("COMMIT");
      return false;
    }
    await client.query("DELETE FROM auth_challenges WHERE id = $1", [id]);
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
function imageType(buffer: Buffer): { mime: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { mime: "image/jpeg", extension: ".jpg" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", extension: ".webp" };
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(buffer.toString("ascii", 8, 12))) return { mime: "image/avif", extension: ".avif" };
  return null;
}
async function saveImage(buffer: Buffer) {
  const type = imageType(buffer);
  if (!type) throw new Error("Yalnızca PNG, JPEG, WebP veya AVIF görselleri yüklenebilir.");
  const filename = `${randomUUID()}${type.extension}`;
  await writeFile(resolve(uploadDirectory, filename), buffer, { flag: "wx" });
  return { url: `/uploads/${filename}`, mime: type.mime };
}
function normalizedSecurityAnswer(value: string) {
  return value.trim().normalize("NFKC");
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/logout", authenticate, async (req: AuthRequest, res, next) => {
  try {
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [req.user!.id]);
    io.to(`user:${req.user!.id}`).emit("session-ended");
    io.in(`user:${req.user!.id}`).disconnectSockets(true);
    return res.json({ message: "Oturum kapatıldı." });
  } catch (error) { next(error); }
});

app.post("/api/auth/register", async (req, res, next) => {
  const { phone, email, password, displayName } = req.body as Record<string, unknown>;
  const username = normalizedUsername(req.body.username);
  const rawUsername = typeof req.body.username === "string" ? req.body.username.trim().replace(/^@/, "") : "";
  if (typeof phone !== "string" || !/^\+?[0-9 ()-]{10,20}$/.test(phone.trim())) return badRequest(res, "Geçerli bir telefon numarası girin.");
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return badRequest(res, "Geçerli bir e-posta adresi girin.");
  if (typeof password !== "string" || password.length < 8 || password.length > 72) return badRequest(res, "Şifre 8–72 karakter arasında olmalı.");
  if (typeof displayName !== "string" || displayName.trim().length < 2 || displayName.trim().length > 40) return badRequest(res, "İsim 2–40 karakter arasında olmalı.");
  if (!validUsername(username) || rawUsername !== username) return badRequest(res, "Kullanıcı adı 3–24 karakter olmalı; boşluk ve büyük harf kullanılamaz.");
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (phone, email, username, display_name, password_hash, email_verified)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, username, display_name, email, is_admin, token_version`,
      [phone.trim(), email.trim().toLowerCase(), username, displayName.trim(), passwordHash]
    );
    const user = result.rows[0];
    await pool.query("INSERT INTO user_settings (user_id, recovery_email) VALUES ($1, $2)", [user.id, user.email]);
    return res.status(201).json({ token: tokenFor(user), user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email, isAdmin: user.is_admin } });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return badRequest(res, "Bu telefon, e-posta veya kullanıcı adı zaten kayıtlı.");
    next(error);
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  const username = normalizedUsername(req.body.username);
  const password = req.body.password;
  if (!username || typeof password !== "string") return badRequest(res, "Kullanıcı adı ve şifre gereklidir.");
  try {
    const { rows } = await pool.query("SELECT id, username, display_name, email, password_hash, is_admin, is_disabled, two_factor_type, security_question, token_version FROM users WHERE username = $1", [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
    if (user.is_disabled) return res.status(403).json({ error: "Bu hesap geçici olarak devre dışı." });
    if (user.two_factor_type) {
      let challengeId: string | null = null;
      if (user.two_factor_type === "email") {
        const settings = await pool.query("SELECT recovery_email FROM user_settings WHERE user_id = $1", [user.id]);
        const destination = settings.rows[0]?.recovery_email || user.email;
        if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return res.status(503).json({ error: "E-posta ile doğrulama yapılandırılmamış." });
        challengeId = await createEmailChallenge(user.id, "login_2fa", destination, user.username);
      }
      const challengeToken = jwt.sign({ sub: user.id, purpose: "login_2fa", challengeId }, jwtSecret!, { expiresIn: "10m" });
      return res.json({
        requiresTwoFactor: true,
        challenge: challengeToken,
        method: user.two_factor_type,
        question: user.security_question || null
      });
    }
    await pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [user.id]);
    return res.json({ token: tokenFor(user), user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email, isAdmin: user.is_admin } });
  } catch (error) { next(error); }
});

app.post("/api/auth/verify-2fa", authLimiter, async (req, res, next) => {
  const challenge = typeof req.body.challenge === "string" ? req.body.challenge : "";
  const answer = typeof req.body.answer === "string" ? req.body.answer.trim() : "";
  if (!challenge || !answer) return badRequest(res, "Doğrulama bilgisi gerekli.");
  try {
    const ticket = jwt.verify(challenge, jwtSecret!) as { sub: string; purpose: string; challengeId?: string };
    if (ticket.purpose !== "login_2fa") return res.status(401).json({ error: "Doğrulama isteği geçersiz." });
    const { rows } = await pool.query("SELECT id, username, display_name, email, is_admin, two_factor_type, security_answer_hash, pin_hash, security_answer_case_sensitive, is_disabled, token_version FROM users WHERE id = $1", [ticket.sub]);
    const user = rows[0];
    if (!user || user.is_disabled) return res.status(401).json({ error: "Hesap kullanılamıyor." });
    let valid = false;
    if (user.two_factor_type === "email" && ticket.challengeId) valid = await consumeEmailChallenge(ticket.challengeId, ticket.sub, "login_2fa", answer);
    if (user.two_factor_type === "pin" && user.pin_hash) valid = await bcrypt.compare(answer, user.pin_hash);
    if (user.two_factor_type === "security_question" && user.security_answer_hash) {
      const normalized = user.security_answer_case_sensitive ? answer : answer.toLocaleLowerCase("tr");
      valid = await bcrypt.compare(normalized, user.security_answer_hash);
    }
    if (!valid) return res.status(401).json({ error: "Doğrulama bilgisi hatalı veya süresi dolmuş." });
    await pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [user.id]);
    return res.json({ token: tokenFor(user), user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email, isAdmin: user.is_admin } });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return res.status(401).json({ error: "Doğrulama isteği geçersiz veya süresi dolmuş." });
    next(error);
  }
});

app.post("/api/auth/password-reset/start", authLimiter, async (req, res, next) => {
  const email = validEmail(req.body.email) ? req.body.email.trim().toLowerCase() : "";
  if (!email) return badRequest(res, "Geçerli bir e-posta adresi girin.");
  try {
    const { rows } = await pool.query("SELECT id, username, email FROM users WHERE lower(email) = $1 AND is_disabled = false", [email]);
    if (rows[0]) {
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return res.status(503).json({ error: "E-posta servisi yapılandırılmamış." });
      await createEmailChallenge(rows[0].id, "password_reset", rows[0].email, rows[0].username);
    }
    return res.json({ message: "Bu e-posta kayıtlıysa sıfırlama kodu gönderildi." });
  } catch (error) { next(error); }
});

app.post("/api/auth/password-reset/finish", authLimiter, async (req, res, next) => {
  const email = validEmail(req.body.email) ? req.body.email.trim().toLowerCase() : "";
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  const password = req.body.password;
  if (!email || !/^\d{6}$/.test(code) || typeof password !== "string" || password.length < 8 || password.length > 72) return badRequest(res, "E-posta, 6 haneli kod ve en az 8 karakterli yeni şifre gereklidir.");
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE lower(email) = $1 AND is_disabled = false", [email]);
    if (!rows[0]) return res.status(400).json({ error: "Kod geçersiz veya süresi dolmuş." });
    const { rowCount } = await pool.query("SELECT 1 FROM auth_challenges WHERE user_id = $1 AND purpose = 'password_reset' AND expires_at > now() AND attempts < 5", [rows[0].id]);
    if (!rowCount) return res.status(400).json({ error: "Kod geçersiz veya süresi dolmuş." });
    const challenge = await pool.query("SELECT id FROM auth_challenges WHERE user_id = $1 AND purpose = 'password_reset' AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC LIMIT 1", [rows[0].id]);
    if (!(await consumeEmailChallenge(challenge.rows[0].id, rows[0].id, "password_reset", code))) return res.status(400).json({ error: "Kod geçersiz veya süresi dolmuş." });
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query("UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2", [passwordHash, rows[0].id]);
    io.to(`user:${rows[0].id}`).emit("session-ended");
    io.in(`user:${rows[0].id}`).disconnectSockets(true);
    return res.json({ message: "Şifren güncellendi. Yeni şifrenle giriş yapabilirsin." });
  } catch (error) { next(error); }
});

app.get("/api/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.phone, u.email, u.avatar_url, u.is_admin, u.two_factor_type, u.security_question,
              s.last_seen_visible, s.online_visible, s.read_receipts, s.show_photos_directly, s.app_theme, s.chat_theme,
              s.chat_locked, s.recovery_email
       FROM users u JOIN user_settings s ON s.user_id = u.id WHERE u.id = $1`,
      [req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    const user = rows[0];
    return res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, phone: user.phone, email: user.email, avatarUrl: user.avatar_url, isAdmin: user.is_admin, twoFactorType: user.two_factor_type, securityQuestion: user.security_question, lastSeenVisible: user.last_seen_visible, onlineVisible: user.online_visible, readReceipts: user.read_receipts, showPhotosDirectly: user.show_photos_directly, appTheme: user.app_theme, chatTheme: user.chat_theme, chatLocked: user.chat_locked, recoveryEmail: user.recovery_email } });
  } catch (error) { next(error); }
});

app.patch("/api/profile", authenticate, async (req: AuthRequest, res, next) => {
  const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
  const username = normalizedUsername(req.body.username);
  const rawUsername = typeof req.body.username === "string" ? req.body.username.trim().replace(/^@/, "") : "";
  if (displayName.length < 2 || displayName.length > 40) return badRequest(res, "Görünen isim 2–40 karakter arasında olmalı.");
  if (!validUsername(username) || rawUsername !== username) return badRequest(res, "Kullanıcı adı 3–24 karakter, küçük harf ve rakamlardan oluşmalı.");
  try {
    const { rows } = await pool.query("UPDATE users SET display_name = $1, username = $2 WHERE id = $3 RETURNING id, username, display_name, email, avatar_url, is_admin", [displayName, username, req.user!.id]);
    return res.json({ user: { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name, email: rows[0].email, avatarUrl: rows[0].avatar_url, isAdmin: rows[0].is_admin } });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return badRequest(res, "Bu kullanıcı adı başka biri tarafından kullanılıyor.");
    next(error);
  }
});

app.post("/api/profile/password", authenticate, async (req: AuthRequest, res, next) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: unknown; newPassword?: unknown };
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 72) return badRequest(res, "Mevcut şifre ve 8–72 karakter arasında yeni bir şifre girin.");
  try {
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) return res.status(401).json({ error: "Mevcut şifren hatalı." });
    await pool.query("UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2", [await bcrypt.hash(newPassword, 12), req.user!.id]);
    io.to(`user:${req.user!.id}`).emit("session-ended");
    io.in(`user:${req.user!.id}`).disconnectSockets(true);
    return res.json({ message: "Şifren güncellendi." });
  } catch (error) { next(error); }
});

app.put("/api/profile/two-factor", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  const { method, question, answer, caseSensitive, pin, password } = req.body as Record<string, unknown>;
  if (typeof password !== "string") return badRequest(res, "Kaydetmek için hesap şifreni gir.");
  if (method !== "none" && !["email", "security_question", "pin"].includes(String(method))) return badRequest(res, "Geçersiz doğrulama yöntemi.");
  if (method === "security_question" && (typeof question !== "string" || !["En sevdiğin isim", "En sevdiğin hayvan", "En sevdiğin arkadaş"].includes(question) || typeof answer !== "string" || normalizedSecurityAnswer(answer).length < 2 || normalizedSecurityAnswer(answer).length > 120 || typeof caseSensitive !== "boolean")) return badRequest(res, "Güvenlik sorusu için soru, en az 2 karakterli yanıt ve harf duyarlılığı seçimi gerekli.");
  if (method === "pin" && (typeof pin !== "string" || !/^\d{6}$/.test(pin))) return badRequest(res, "PIN tam 6 rakam olmalı.");
  try {
    const account = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
    if (!account.rows[0] || !(await bcrypt.compare(password, account.rows[0].password_hash))) return res.status(401).json({ error: "Hesap şifren hatalı." });
    if (method === "email" && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) return res.status(503).json({ error: "E-posta doğrulaması için RESEND_API_KEY ve EMAIL_FROM ayarlayın." });
    const normalized = typeof answer === "string" ? normalizedSecurityAnswer(answer) : "";
    const answerHash = method === "security_question" ? await bcrypt.hash(caseSensitive ? normalized : normalized.toLocaleLowerCase("tr"), 12) : null;
    const pinHash = method === "pin" ? await bcrypt.hash(pin as string, 12) : null;
    await pool.query(
      "UPDATE users SET two_factor_type = $1, security_question = $2, security_answer_hash = $3, security_answer_case_sensitive = $4, pin_hash = $5 WHERE id = $6",
      [method === "none" ? null : method, method === "security_question" ? question : null, answerHash, method === "security_question" ? caseSensitive : false, pinHash, req.user!.id]
    );
    return res.json({ message: method === "none" ? "İki aşamalı doğrulama kapatıldı." : "İki aşamalı doğrulama güncellendi.", method });
  } catch (error) { next(error); }
});

app.post("/api/profile/recovery-email/request", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  const email = validEmail(req.body.email) ? req.body.email.trim().toLowerCase() : "";
  const password = req.body.password;
  if (!email || typeof password !== "string") return badRequest(res, "Geçerli e-posta adresi ve hesap şifresi gerekli.");
  try {
    const { rows } = await pool.query("SELECT username, email, password_hash FROM users WHERE id = $1", [req.user!.id]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: "Hesap şifren hatalı." });
    if (email === rows[0].email.toLowerCase()) {
      await pool.query("UPDATE user_settings SET recovery_email = $1 WHERE user_id = $2", [email, req.user!.id]);
      return res.json({ verified: true, email });
    }
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return res.status(503).json({ error: "E-posta servisi yapılandırılmamış." });
    await pool.query("DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = 'email_change'", [req.user!.id]);
    const code = String(randomInt(100000, 1000000));
    const hash = await bcrypt.hash(code, 10);
    await pool.query("INSERT INTO auth_challenges (user_id, purpose, code_hash, target_value, expires_at) VALUES ($1, 'email_change', $2, $3, now() + interval '10 minutes')", [req.user!.id, hash, email]);
    try { await sendEmail(email, "Kurtarma e-postası doğrulama kodun", "E-posta adresini doğrula", "Bu adresi ZibZib kurtarma e-postası olarak eklemek için kodu gir.", code); }
    catch (error) { await pool.query("DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = 'email_change'", [req.user!.id]); throw error; }
    return res.json({ verified: false, email: maskEmail(email) });
  } catch (error) { next(error); }
});

app.post("/api/profile/recovery-email/confirm", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return badRequest(res, "6 haneli doğrulama kodunu gir.");
  try {
    const challenge = await pool.query("SELECT id, target_value FROM auth_challenges WHERE user_id = $1 AND purpose = 'email_change' AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC LIMIT 1", [req.user!.id]);
    if (!challenge.rows[0] || !(await consumeEmailChallenge(challenge.rows[0].id, req.user!.id, "email_change", code))) return res.status(400).json({ error: "Kod geçersiz veya süresi dolmuş." });
    await pool.query("UPDATE user_settings SET recovery_email = $1, updated_at = now() WHERE user_id = $2", [challenge.rows[0].target_value, req.user!.id]);
    return res.json({ recoveryEmail: challenge.rows[0].target_value });
  } catch (error) { next(error); }
});

app.post("/api/profile/avatar", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => {
  if (!req.file) return badRequest(res, "Profil fotoğrafı seçin.");
  try {
    const image = await saveImage(req.file.buffer);
    await pool.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [image.url, req.user!.id]);
    return res.json({ avatarUrl: image.url });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Yalnızca")) return badRequest(res, error.message);
    next(error);
  }
});

app.post("/api/profile/lock/enable", authenticate, async (req: AuthRequest, res, next) => {
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  const password = req.body.password;
  if (code.length < 4 || code.length > 32) return badRequest(res, "Sohbet kilidi kodu 4–32 karakter arasında olmalı.");
  if (typeof password !== "string") return badRequest(res, "Hesap şifreni doğrula.");
  try {
    const account = await pool.query("SELECT password_hash, email FROM users WHERE id = $1", [req.user!.id]);
    if (!account.rows[0] || !(await bcrypt.compare(password, account.rows[0].password_hash))) return res.status(401).json({ error: "Hesap şifren hatalı." });
    const settings = await pool.query("SELECT recovery_email FROM user_settings WHERE user_id = $1", [req.user!.id]);
    const recoveryEmail = settings.rows[0]?.recovery_email || account.rows[0].email;
    if (!recoveryEmail) return badRequest(res, "Önce güvenlik ayarlarından kurtarma e-postası ekle.");
    await pool.query("UPDATE user_settings SET chat_locked = true, lock_code_hash = $1, recovery_email = $2, updated_at = now() WHERE user_id = $3", [await bcrypt.hash(code, 12), recoveryEmail, req.user!.id]);
    return res.json({ message: "Sohbet kilidi etkinleştirildi.", recoveryEmail: maskEmail(recoveryEmail) });
  } catch (error) { next(error); }
});

app.post("/api/profile/lock/verify", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  try {
    const settings = await pool.query("SELECT lock_code_hash, chat_locked FROM user_settings WHERE user_id = $1", [req.user!.id]);
    if (!settings.rows[0]?.chat_locked || !settings.rows[0].lock_code_hash) return res.status(400).json({ error: "Sohbet kilidi etkin değil." });
    if (!(await bcrypt.compare(code, settings.rows[0].lock_code_hash))) return res.status(401).json({ error: "Sohbet kilidi kodu hatalı." });
    const chats = await pool.query("SELECT conversation_id FROM conversation_user_settings WHERE user_id = $1 AND is_locked = true", [req.user!.id]);
    const conversations = chats.rows.map((item) => item.conversation_id as string);
    const unlockToken = jwt.sign({ sub: req.user!.id, purpose: "locked_chats", conversations }, jwtSecret!, { expiresIn: "12h" });
    return res.json({ token: unlockToken, conversations });
  } catch (error) { next(error); }
});

app.post("/api/profile/lock/recovery/request", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT u.username, s.recovery_email FROM users u JOIN user_settings s ON s.user_id = u.id WHERE u.id = $1 AND s.chat_locked = true",
      [req.user!.id]
    );
    if (!rows[0]) return res.status(400).json({ error: "Sohbet kilidi etkin değil." });
    if (!rows[0].recovery_email) return res.status(400).json({ error: "Kurtarma e-postası ayarlanmamış." });
    const challengeId = await createEmailChallenge(req.user!.id, "lock_recovery", rows[0].recovery_email, rows[0].username);
    return res.json({ challengeId, email: maskEmail(rows[0].recovery_email) });
  } catch (error) { next(error); }
});

app.post("/api/profile/lock/recovery/confirm", authenticate, authLimiter, async (req: AuthRequest, res, next) => {
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return badRequest(res, "6 haneli e-posta kodunu gir.");
  try {
    const challenge = await pool.query("SELECT id FROM auth_challenges WHERE user_id = $1 AND purpose = 'lock_recovery' AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC LIMIT 1", [req.user!.id]);
    if (!challenge.rows[0] || !(await consumeEmailChallenge(challenge.rows[0].id, req.user!.id, "lock_recovery", code))) return res.status(400).json({ error: "Kod geçersiz veya süresi dolmuş." });
    await pool.query("UPDATE user_settings SET lock_code_hash = NULL, chat_locked = false WHERE user_id = $1", [req.user!.id]);
    await pool.query("UPDATE conversation_user_settings SET is_locked = false WHERE user_id = $1", [req.user!.id]);
    return res.json({ message: "Sohbet kilidi sıfırlandı. Ayarlardan yeni bir kod belirleyebilirsin." });
  } catch (error) { next(error); }
});

app.patch("/api/conversations/:id/lock", authenticate, async (req: AuthRequest, res, next) => {
  const locked = req.body.locked === true;
  const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const member = await client.query("SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [req.params.id, req.user!.id]);
    if (!member.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Sohbet bulunamadı." }); }
    const settings = await client.query("SELECT chat_locked, lock_code_hash FROM user_settings WHERE user_id = $1 FOR UPDATE", [req.user!.id]);
    if (locked && !settings.rows[0]?.chat_locked) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Önce sohbet kilidini etkinleştir." }); }
    if (locked && settings.rows[0].lock_code_hash && !(await bcrypt.compare(code, settings.rows[0].lock_code_hash))) { await client.query("ROLLBACK"); return res.status(401).json({ error: "Sohbet kilidi kodu hatalı." }); }
    await client.query(
      `INSERT INTO conversation_user_settings (conversation_id, user_id, is_locked) VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET is_locked = EXCLUDED.is_locked`,
      [req.params.id, req.user!.id, locked]
    );
    await client.query("COMMIT");
    return res.json({ locked });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.get("/api/public/settings", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM app_settings WHERE key IN ('default_avatar_url', 'light_chat_background', 'dark_chat_background', 'light_background', 'dark_background')");
    return res.json({ settings: Object.fromEntries(rows.map((item) => [item.key, item.value])) });
  } catch (error) { next(error); }
});

app.get("/api/users/search", authenticate, async (req: AuthRequest, res, next) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().replace(/^@/, "") : "";
  if (query.length < 2) return badRequest(res, "Arama için en az 2 karakter girin.");
  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, avatar_url FROM users
       WHERE id <> $1 AND (username ILIKE $2 OR display_name ILIKE $2) LIMIT 20`,
      [req.user!.id, `%${query}%`]
    );
    return res.json({ users: rows });
  } catch (error) { next(error); }
});

app.post("/api/friend-requests", authenticate, async (req: AuthRequest, res, next) => {
  const username = normalizedUsername(req.body.username);
  try {
    const target = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (!target.rowCount) return res.status(404).json({ error: "Bu kullanıcı bulunamadı." });
    if (target.rows[0].id === req.user!.id) return badRequest(res, "Kendinize arkadaşlık isteği gönderemezsiniz.");
    const exists = await pool.query(
      "SELECT id, status FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)",
      [req.user!.id, target.rows[0].id]
    );
    if (exists.rowCount) return badRequest(res, exists.rows[0].status === "accepted" ? "Bu kişi zaten arkadaşınız." : "Bu kişi için zaten bekleyen bir istek var.");
    const inserted = await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending') RETURNING id", [req.user!.id, target.rows[0].id]);
    io.to(`user:${target.rows[0].id}`).emit("friend-request", { id: inserted.rows[0].id, username: req.user!.username });
    return res.status(201).json({ status: "pending" });
  } catch (error) { next(error); }
});

app.get("/api/friend-requests", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.status, f.created_at, f.requester_id, f.addressee_id,
              u.username AS requester_username, u.display_name AS requester_name, u.avatar_url AS requester_avatar_url,
              v.username AS addressee_username, v.display_name AS addressee_name, v.avatar_url AS addressee_avatar_url
       FROM friendships f JOIN users u ON u.id = f.requester_id JOIN users v ON v.id = f.addressee_id
       WHERE f.status = 'pending' AND (f.requester_id = $1 OR f.addressee_id = $1) ORDER BY f.created_at DESC`,
      [req.user!.id]
    );
    return res.json({ requests: rows });
  } catch (error) { next(error); }
});

app.post("/api/friend-requests/:id/respond", authenticate, async (req: AuthRequest, res, next) => {
  const accepted = req.body.accept === true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM friendships WHERE id = $1 AND addressee_id = $2 AND status = 'pending' FOR UPDATE", [req.params.id, req.user!.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bekleyen istek bulunamadı." }); }
    if (!accepted) {
      await client.query("DELETE FROM friendships WHERE id = $1", [req.params.id]);
      await client.query("COMMIT");
      io.to(`user:${rows[0].requester_id}`).emit("friend-request-response", { requestId: req.params.id, accepted: false });
      return res.json({ status: "rejected" });
    }
    await client.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [req.params.id]);
    const conversation = await client.query("INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id", [req.user!.id]);
    await client.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)", [conversation.rows[0].id, rows[0].requester_id, rows[0].addressee_id]);
    await client.query("INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3)", [conversation.rows[0].id, req.user!.id, "Artık arkadaşsınız"]);
    await client.query("COMMIT");
    io.to(`user:${rows[0].requester_id}`).emit("friend-request-response", { requestId: req.params.id, accepted: true, conversationId: conversation.rows[0].id });
    return res.json({ status: "accepted", conversationId: conversation.rows[0].id });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.post("/api/conversations/self", authenticate, async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.kind = 'self' AND cm.user_id = $1 LIMIT 1",
      [req.user!.id]
    );
    if (existing.rowCount) return res.json({ conversationId: existing.rows[0].id });
    await client.query("BEGIN");
    const { rows } = await client.query("INSERT INTO conversations (kind, created_by) VALUES ('self', $1) RETURNING id", [req.user!.id]);
    await client.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [rows[0].id, req.user!.id]);
    await client.query("COMMIT");
    return res.status(201).json({ conversationId: rows[0].id });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.post("/api/conversations/groups", authenticate, async (req: AuthRequest, res, next) => {
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const memberIds = req.body.memberIds;
  const messagePolicy = req.body.messagePolicy ?? "all";
  const photoPolicy = req.body.photoPolicy ?? "all";
  const allowedUserIds = req.body.allowedUserIds;
  if (title.length < 2 || title.length > 60) return badRequest(res, "Grup adı 2–60 karakter arasında olmalı.");
  if (!["all", "admins", "selected"].includes(messagePolicy)) return badRequest(res, "Geçersiz mesaj gönderme izni.");
  if (!["all", "admins", "none"].includes(photoPolicy)) return badRequest(res, "Geçersiz fotoğraf gönderme izni.");
  if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > 99 || memberIds.some((id: unknown) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    return badRequest(res, "En az bir, en fazla 99 geçerli grup üyesi seçin.");
  }
  const selectedIds = [...new Set(memberIds as string[])].filter((id) => id !== req.user!.id);
  if (!selectedIds.length) return badRequest(res, "Gruba en az bir arkadaş ekleyin.");
  if (messagePolicy === "selected" && (!Array.isArray(allowedUserIds) || allowedUserIds.length < 1 || allowedUserIds.some((id: unknown) => typeof id !== "string" || !selectedIds.includes(id)))) {
    return badRequest(res, "Mesaj gönderebilecek en az bir grup üyesi seçin.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const friends = await client.query(
      `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS user_id
       FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
       AND CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END = ANY($2::uuid[])`,
      [req.user!.id, selectedIds]
    );
    if (friends.rowCount !== selectedIds.length) { await client.query("ROLLBACK"); return badRequest(res, "Yalnızca arkadaşlarınızı gruba ekleyebilirsiniz."); }
    const { rows } = await client.query(
      "INSERT INTO conversations (title, kind, created_by, message_policy, photo_policy) VALUES ($1, 'group', $2, $3, $4) RETURNING id",
      [title, req.user!.id, messagePolicy, photoPolicy]
    );
    await client.query("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')", [rows[0].id, req.user!.id]);
    await client.query(
      "INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, member_id FROM unnest($2::uuid[]) AS member_id",
      [rows[0].id, selectedIds]
    );
    if (messagePolicy === "selected") {
      await client.query(
        "INSERT INTO group_allowed_senders (conversation_id, user_id) SELECT $1, member_id FROM unnest($2::uuid[]) AS member_id",
        [rows[0].id, allowedUserIds]
      );
    }
    await client.query("COMMIT");
    for (const userId of selectedIds) io.to(`user:${userId}`).emit("group-invitation", { conversationId: rows[0].id, title });
    return res.status(201).json({ conversationId: rows[0].id });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.post("/api/conversations/:id/avatar", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => {
  if (!req.file) return badRequest(res, "Bir grup görseli seçin.");
  try {
    const member = await pool.query(
      "SELECT 1 FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 AND cm.role = 'admin' AND c.kind = 'group'",
      [req.params.id, req.user!.id]
    );
    if (!member.rowCount) return res.status(403).json({ error: "Grup görselini yalnızca grup yöneticileri değiştirebilir." });
    const image = await saveImage(req.file.buffer);
    await pool.query("UPDATE conversations SET avatar_url = $1 WHERE id = $2", [image.url, req.params.id]);
    return res.json({ avatarUrl: image.url });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Yalnızca")) return badRequest(res, error.message);
    next(error);
  }
});

app.post("/api/broadcasts", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => {
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
  let recipientIds: unknown = req.body.userIds;
  if (typeof recipientIds === "string") {
    try { recipientIds = JSON.parse(recipientIds); }
    catch { return badRequest(res, "Alıcı listesi geçersiz."); }
  }
  if ((!message && !req.file) || message.length > 4000) return badRequest(res, "Mesaj yazın veya bir fotoğraf seçin.");
  if (!Array.isArray(recipientIds) || recipientIds.length < 1 || recipientIds.length > 99 || recipientIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return badRequest(res, "1–99 arkadaş seçin.");
  const selectedIds = [...new Set(recipientIds as string[])].filter((id) => id !== req.user!.id);
  if (!selectedIds.length) return badRequest(res, "Kendiniz yerine arkadaşlarınızı seçin.");
  let attachmentUrl: string | null = null;
  if (req.file) {
    try { attachmentUrl = (await saveImage(req.file.buffer)).url; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Yalnızca")) return badRequest(res, error.message);
      return next(error);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const friends = await client.query(
      `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS user_id
       FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
       AND CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END = ANY($2::uuid[])`,
      [req.user!.id, selectedIds]
    );
    if (friends.rowCount !== selectedIds.length) { await client.query("ROLLBACK"); return badRequest(res, "Yalnızca arkadaşlarınıza toplu mesaj gönderebilirsiniz."); }
    const outgoing: { conversationId: string; message: Record<string, unknown> }[] = [];
    for (const peerId of selectedIds) {
      let conversation = await client.query(
        `SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
         JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2 WHERE c.kind = 'direct' LIMIT 1`,
        [req.user!.id, peerId]
      );
      if (!conversation.rows[0]) {
        conversation = await client.query("INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id", [req.user!.id]);
        await client.query("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [conversation.rows[0].id, req.user!.id, peerId]);
      }
      const { rows } = await client.query(
        "INSERT INTO messages (conversation_id, sender_id, body, attachment_url) VALUES ($1, $2, $3, $4) RETURNING id, conversation_id, sender_id, body, attachment_url, created_at",
        [conversation.rows[0].id, req.user!.id, message || null, attachmentUrl]
      );
      await client.query("INSERT INTO message_receipts (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [rows[0].id, peerId]);
      outgoing.push({ conversationId: conversation.rows[0].id, message: rows[0] });
    }
    await client.query("COMMIT");
    for (const item of outgoing) io.to(`conversation:${item.conversationId}`).emit("message", item.message);
    return res.status(201).json({ sent: outgoing.length });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.patch("/api/conversations/:id/settings", authenticate, async (req: AuthRequest, res, next) => {
  const { messagePolicy, photoPolicy, allowedUserIds } = req.body as { messagePolicy?: unknown; photoPolicy?: unknown; allowedUserIds?: unknown };
  if (messagePolicy !== undefined && !["all", "admins", "selected"].includes(String(messagePolicy))) return badRequest(res, "Geçersiz mesaj gönderme izni.");
  if (photoPolicy !== undefined && !["all", "admins", "none"].includes(String(photoPolicy))) return badRequest(res, "Geçersiz fotoğraf gönderme izni.");
  if (messagePolicy === "selected" && (!Array.isArray(allowedUserIds) || allowedUserIds.length < 1 || allowedUserIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))) return badRequest(res, "Belirli üyeleri seçin.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query(
      "SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 FOR UPDATE",
      [req.params.id, req.user!.id]
    );
    if (!membership.rowCount || membership.rows[0].kind !== "group") { await client.query("ROLLBACK"); return res.status(404).json({ error: "Grup bulunamadı." }); }
    if (membership.rows[0].role !== "admin") { await client.query("ROLLBACK"); return res.status(403).json({ error: "Grup ayarlarını yalnızca yöneticiler değiştirebilir." }); }
    if (messagePolicy !== undefined) await client.query("UPDATE conversations SET message_policy = $1 WHERE id = $2", [messagePolicy, req.params.id]);
    if (photoPolicy !== undefined) await client.query("UPDATE conversations SET photo_policy = $1 WHERE id = $2", [photoPolicy, req.params.id]);
    if (messagePolicy === "selected") {
      const users = await client.query("SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id = ANY($2::uuid[])", [req.params.id, allowedUserIds]);
      if (users.rowCount !== (allowedUserIds as string[]).length) { await client.query("ROLLBACK"); return badRequest(res, "Yalnızca grup üyelerini seçebilirsiniz."); }
      await client.query("DELETE FROM group_allowed_senders WHERE conversation_id = $1", [req.params.id]);
      await client.query("INSERT INTO group_allowed_senders (conversation_id, user_id) SELECT $1, member_id FROM unnest($2::uuid[]) AS member_id", [req.params.id, allowedUserIds]);
    } else if (messagePolicy === "all" || messagePolicy === "admins") {
      await client.query("DELETE FROM group_allowed_senders WHERE conversation_id = $1", [req.params.id]);
    }
    await client.query("COMMIT");
    return res.json({ status: "updated" });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.get("/api/conversations", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.avatar_url, c.kind, c.created_at,
         peer.id AS peer_id, peer.display_name AS peer_name, peer.username AS peer_username, peer.avatar_url AS peer_avatar_url,
         COALESCE(cus.is_muted, false) AS is_muted, COALESCE(cus.is_archived, false) AS is_archived, COALESCE(cus.is_locked, false) AS is_locked,
         (SELECT CASE WHEN m.deleted_for_all THEN 'Bu mesaj silindi' WHEN m.attachment_url IS NOT NULL THEN 'Fotoğraf' ELSE m.body END FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
         (SELECT count(*)::int FROM message_receipts r JOIN messages m ON m.id = r.message_id
          WHERE m.conversation_id = c.id AND r.user_id = $1 AND r.read_at IS NULL AND m.sender_id <> $1
            AND EXISTS (SELECT 1 FROM user_settings us WHERE us.user_id = $1 AND us.read_receipts = true)) AS unread_count,
         (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       LEFT JOIN conversation_user_settings cus ON cus.conversation_id = c.id AND cus.user_id = $1
       LEFT JOIN LATERAL (
         SELECT u.id, u.display_name, u.username, u.avatar_url FROM conversation_members other_member
         JOIN users u ON u.id = other_member.user_id
         WHERE other_member.conversation_id = c.id AND other_member.user_id <> $1 LIMIT 1
       ) peer ON true
       WHERE cm.user_id = $1
         AND COALESCE(cus.is_archived, false) = $2
         AND (COALESCE(cus.is_locked, false) = false OR c.id = ANY($3::uuid[]))
       ORDER BY COALESCE((SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at) DESC`,
      [req.user!.id, req.query.archived === "true", req.lockedConversationIds || []]
    );
    return res.json({ conversations: rows });
  } catch (error) { next(error); }
});

app.get("/api/conversations/:id/members", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const membership = await pool.query("SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [req.params.id, req.user!.id]);
    if (!membership.rowCount) return res.status(404).json({ error: "Sohbet bulunamadı." });
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.last_seen_at,
              s.online_visible, s.last_seen_visible, cm.role
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       JOIN user_settings s ON s.user_id = u.id WHERE cm.conversation_id = $1`,
      [req.params.id]
    );
    return res.json({ members: rows.map((member) => ({
      id: member.id, username: member.username, displayName: member.display_name, avatarUrl: member.avatar_url, role: member.role,
      online: member.online_visible && onlineUsers.has(member.id),
      lastSeen: member.last_seen_visible ? member.last_seen_at : null
    })) });
  } catch (error) { next(error); }
});

app.get("/api/users/:id/presence", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.last_seen_at, s.online_visible, s.last_seen_visible FROM users u
       JOIN user_settings s ON s.user_id = u.id WHERE u.id = $1 AND EXISTS (
         SELECT 1 FROM friendships f WHERE f.status = 'accepted'
         AND ((f.requester_id = $2 AND f.addressee_id = u.id) OR (f.addressee_id = $2 AND f.requester_id = u.id))
       )`,
      [req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Kişi bulunamadı." });
    return res.json({ online: rows[0].online_visible && onlineUsers.has(routeParam(req.params.id)), lastSeen: rows[0].last_seen_visible ? rows[0].last_seen_at : null });
  } catch (error) { next(error); }
});

app.patch("/api/conversations/:id/preferences", authenticate, async (req: AuthRequest, res, next) => {
  const { muted, archived } = req.body as { muted?: unknown; archived?: unknown };
  if ((muted !== undefined && typeof muted !== "boolean") || (archived !== undefined && typeof archived !== "boolean")) return badRequest(res, "Geçersiz sohbet tercihi.");
  if (muted === undefined && archived === undefined) return badRequest(res, "Güncellenecek tercih gönderilmedi.");
  try {
    const member = await pool.query("SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [req.params.id, req.user!.id]);
    if (!member.rowCount) return res.status(404).json({ error: "Sohbet bulunamadı." });
    await pool.query(
      `INSERT INTO conversation_user_settings (conversation_id, user_id, is_muted, is_archived)
       VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false))
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET
       is_muted = COALESCE($3, conversation_user_settings.is_muted),
       is_archived = COALESCE($4, conversation_user_settings.is_archived)`,
      [req.params.id, req.user!.id, muted ?? null, archived ?? null]
    );
    return res.json({ muted, archived });
  } catch (error) { next(error); }
});

app.get("/api/conversations/:id/messages", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const membership = await pool.query(
      "SELECT COALESCE(cus.is_locked, false) AS is_locked FROM conversation_members cm LEFT JOIN conversation_user_settings cus ON cus.conversation_id = cm.conversation_id AND cus.user_id = cm.user_id WHERE cm.conversation_id = $1 AND cm.user_id = $2",
      [req.params.id, req.user!.id]
    );
    if (!membership.rowCount) return res.status(404).json({ error: "Sohbet bulunamadı." });
    if (membership.rows[0].is_locked && !(req.lockedConversationIds || []).includes(routeParam(req.params.id))) return res.status(423).json({ error: "Bu sohbet kilitli." });
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.attachment_url, m.reply_to, m.edited_at, m.deleted_for_all, m.created_at,
              u.id AS sender_id, u.username AS sender_username, u.display_name AS sender_name,
              CASE WHEN own.read_receipts THEN EXISTS(
                SELECT 1 FROM message_receipts r JOIN user_settings recipient ON recipient.user_id = r.user_id
                WHERE r.message_id = m.id AND r.read_at IS NOT NULL AND recipient.read_receipts = true
              ) ELSE false END AS read_by_peer
       FROM messages m JOIN users u ON u.id = m.sender_id
       JOIN user_settings own ON own.user_id = $2
       WHERE m.conversation_id = $1 AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = $2)
       ORDER BY m.created_at ASC LIMIT 200`,
      [req.params.id, req.user!.id]
    );
    return res.json({ messages: rows });
  } catch (error) { next(error); }
});

app.post("/api/conversations/:id/read", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const membership = await pool.query(
      `SELECT COALESCE(s.read_receipts, true) AS read_receipts, COALESCE(cus.is_locked, false) AS is_locked
       FROM conversation_members cm JOIN user_settings s ON s.user_id = cm.user_id
       LEFT JOIN conversation_user_settings cus ON cus.conversation_id = cm.conversation_id AND cus.user_id = cm.user_id
       WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!membership.rowCount) return res.status(404).json({ error: "Sohbet bulunamadı." });
    if (membership.rows[0].is_locked && !(req.lockedConversationIds || []).includes(routeParam(req.params.id))) return res.status(423).json({ error: "Bu sohbet kilitli." });
    if (!membership.rows[0].read_receipts) return res.json({ updated: 0 });
    const { rows } = await pool.query(
      `UPDATE message_receipts r SET read_at = now()
       FROM messages m WHERE r.message_id = m.id AND m.conversation_id = $1 AND r.user_id = $2 AND r.read_at IS NULL
       RETURNING r.message_id`,
      [req.params.id, req.user!.id]
    );
    const messageIds = rows.map((row) => row.message_id);
    io.to(`conversation:${req.params.id}`).emit("read-receipt", { userId: req.user!.id, messageIds });
    return res.json({ updated: messageIds.length });
  } catch (error) { next(error); }
});

app.post("/api/conversations/:id/messages", authenticate, async (req: AuthRequest, res, next) => {
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 4000) return badRequest(res, "Mesaj 1–4000 karakter arasında olmalı.");
  try {
    const member = await pool.query(
      `SELECT c.kind, c.message_policy, cm.role, COALESCE(cus.is_locked, false) AS is_locked,
         EXISTS (SELECT 1 FROM group_allowed_senders gas WHERE gas.conversation_id = c.id AND gas.user_id = $2) AS allowed_sender
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       LEFT JOIN conversation_user_settings cus ON cus.conversation_id = c.id AND cus.user_id = $2
       WHERE c.id = $1 AND cm.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!member.rowCount) return res.status(404).json({ error: "Sohbet bulunamadı." });
    const group = member.rows[0];
    if (group.is_locked && !(req.lockedConversationIds || []).includes(routeParam(req.params.id))) return res.status(423).json({ error: "Bu sohbet kilitli." });
    if (group.kind === "group" && group.message_policy === "admins" && group.role !== "admin") return res.status(403).json({ error: "Bu grupta yalnızca yöneticiler mesaj gönderebilir." });
    if (group.kind === "group" && group.message_policy === "selected" && group.role !== "admin" && !group.allowed_sender) return res.status(403).json({ error: "Yalnızca seçilen üyeler mesaj gönderebilir." });
    const { rows } = await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, body, reply_to) VALUES ($1, $2, $3, $4) RETURNING id, conversation_id, sender_id, body, reply_to, created_at",
      [req.params.id, req.user!.id, body, req.body.replyTo || null]
    );
    await pool.query(
      "INSERT INTO message_receipts (message_id, user_id) SELECT $1, user_id FROM conversation_members WHERE conversation_id = $2 AND user_id <> $3 ON CONFLICT DO NOTHING",
      [rows[0].id, req.params.id, req.user!.id]
    );
    io.to(`conversation:${req.params.id}`).emit("message", rows[0]);
    return res.status(201).json({ message: rows[0] });
  } catch (error) { next(error); }
});

app.post("/api/conversations/:id/messages/image", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => {
  if (!req.file) return badRequest(res, "Göndermek için bir fotoğraf seçin.");
  try {
    const { rows: memberRows } = await pool.query(
      `SELECT c.kind, c.message_policy, c.photo_policy, cm.role, COALESCE(cus.is_locked, false) AS is_locked,
         EXISTS (SELECT 1 FROM group_allowed_senders gas WHERE gas.conversation_id = c.id AND gas.user_id = $2) AS allowed_sender
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       LEFT JOIN conversation_user_settings cus ON cus.conversation_id = c.id AND cus.user_id = $2
       WHERE c.id = $1 AND cm.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    const member = memberRows[0];
    if (!member) return res.status(404).json({ error: "Sohbet bulunamadı." });
    if (member.is_locked && !(req.lockedConversationIds || []).includes(routeParam(req.params.id))) return res.status(423).json({ error: "Bu sohbet kilitli." });
    if (member.kind === "group" && member.photo_policy === "none") return res.status(403).json({ error: "Bu grupta fotoğraf paylaşımı kapalı." });
    if (member.kind === "group" && (member.photo_policy === "admins" || member.message_policy === "admins") && member.role !== "admin") return res.status(403).json({ error: "Bu grupta yalnızca yöneticiler fotoğraf gönderebilir." });
    if (member.kind === "group" && member.message_policy === "selected" && member.role !== "admin" && !member.allowed_sender) return res.status(403).json({ error: "Yalnızca seçilen üyeler mesaj gönderebilir." });
    const image = await saveImage(req.file.buffer);
    const { rows } = await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, attachment_url) VALUES ($1, $2, $3) RETURNING id, conversation_id, sender_id, attachment_url, created_at",
      [req.params.id, req.user!.id, image.url]
    );
    await pool.query(
      "INSERT INTO message_receipts (message_id, user_id) SELECT $1, user_id FROM conversation_members WHERE conversation_id = $2 AND user_id <> $3 ON CONFLICT DO NOTHING",
      [rows[0].id, req.params.id, req.user!.id]
    );
    io.to(`conversation:${req.params.id}`).emit("message", rows[0]);
    return res.status(201).json({ message: rows[0] });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Yalnızca")) return badRequest(res, error.message);
    next(error);
  }
});

app.delete("/api/messages/:id", authenticate, async (req: AuthRequest, res, next) => {
  const forEveryone = req.query.everyone === "true";
  try {
    const { rows } = await pool.query(
      "SELECT m.id, m.sender_id, m.conversation_id, c.kind FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2 WHERE m.id = $1",
      [req.params.id, req.user!.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Mesaj bulunamadı." });
    if (forEveryone && rows[0].sender_id !== req.user!.id) return res.status(403).json({ error: "Yalnızca kendi mesajınızı herkesten silebilirsiniz." });
    if (forEveryone && rows[0].kind !== "self") await pool.query("UPDATE messages SET deleted_for_all = true, body = NULL, attachment_url = NULL WHERE id = $1", [req.params.id]);
    else await pool.query("INSERT INTO message_deletions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.id, req.user!.id]);
    io.to(`conversation:${rows[0].conversation_id}`).emit("message-deleted", { id: req.params.id, conversationId: rows[0].conversation_id, deletedForAll: forEveryone && rows[0].kind !== "self" });
    return res.json({ status: "deleted" });
  } catch (error) { next(error); }
});

app.patch("/api/messages/:id", authenticate, async (req: AuthRequest, res, next) => {
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 4000) return badRequest(res, "Mesaj 1–4000 karakter arasında olmalı.");
  try {
    const { rows } = await pool.query(
      "UPDATE messages SET body = $1, edited_at = now() WHERE id = $2 AND sender_id = $3 AND deleted_for_all = false RETURNING id, conversation_id, sender_id, body, edited_at, created_at",
      [body, req.params.id, req.user!.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Düzenlenebilir mesaj bulunamadı." });
    io.to(`conversation:${rows[0].conversation_id}`).emit("message-edited", rows[0]);
    return res.json({ message: rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/settings", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.last_seen_visible, s.online_visible, s.read_receipts, s.show_photos_directly,
              s.app_theme, s.chat_theme, s.chat_locked, s.recovery_email, u.two_factor_type,
              u.security_question, u.email
       FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
      [req.user!.id]
    );
    return res.json({ settings: rows[0] });
  } catch (error) { next(error); }
});

app.patch("/api/settings", authenticate, async (req: AuthRequest, res, next) => {
  const allowed = ["last_seen_visible", "online_visible", "read_receipts", "show_photos_directly", "app_theme", "chat_theme"];
  const updates = allowed.filter((key) => ["app_theme", "chat_theme"].includes(key)
    ? req.body[key] === "light" || req.body[key] === "dark"
    : typeof req.body[key] === "boolean");
  if (!updates.length) return badRequest(res, "Güncellenecek ayar bulunamadı.");
  try {
    const values: unknown[] = [req.user!.id];
    const assignments = updates.map((key, index) => { values.push(req.body[key]); return `${key} = $${index + 2}`; });
    const { rows } = await pool.query(`UPDATE user_settings SET ${assignments.join(", ")}, updated_at = now() WHERE user_id = $1 RETURNING *`, values);
    return res.json({ settings: rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/admin/summary", authenticate, adminOnly, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM users)::int AS users,
       (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours')::int AS messages_today,
       (SELECT count(*) FROM users WHERE last_seen_at > now() - interval '5 minutes')::int AS online_now,
       (SELECT count(*) FROM friendships WHERE status = 'pending')::int AS pending_requests`
    );
    return res.json({ summary: rows[0] });
  } catch (error) { next(error); }
});

app.patch("/api/admin/settings/:key", authenticate, adminOnly, async (req, res, next) => {
  const allowedKeys = ["default_avatar_url", "light_chat_background", "dark_chat_background", "light_background", "dark_background"];
  const key = req.params.key;
  const value = req.body.value;
  if (typeof key !== "string" || !allowedKeys.includes(key) || typeof value !== "string" || value.length > 2048) return badRequest(res, "Geçersiz yönetim ayarı.");
  try {
    await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, value]);
    return res.json({ key, value });
  } catch (error) { next(error); }
});

app.get("/api/admin/settings", authenticate, adminOnly, async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT key, value, updated_at FROM app_settings ORDER BY key");
    return res.json({ settings: Object.fromEntries(rows.map((item) => [item.key, { value: item.value, updatedAt: item.updated_at }])) });
  } catch (error) { next(error); }
});

app.post("/api/admin/uploads", authenticate, adminOnly, upload.single("image"), async (req: AuthRequest, res, next) => {
  const key = typeof req.body.key === "string" ? req.body.key : "";
  if (!["default_avatar_url", "light_chat_background", "dark_chat_background"].includes(key)) return badRequest(res, "Görsel ayarı tanınmadı.");
  if (!req.file) return badRequest(res, "Yüklemek için bir görsel seçin.");
  try {
    const image = await saveImage(req.file.buffer);
    await pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, image.url]);
    return res.json({ key, value: image.url });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Yalnızca")) return badRequest(res, error.message);
    next(error);
  }
});

app.get("/api/admin/users", authenticate, adminOnly, async (req, res, next) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, email, phone, avatar_url, is_admin, is_disabled, created_at
       FROM users WHERE ($1 = '' OR username ILIKE $2 OR display_name ILIKE $2 OR email ILIKE $2)
       ORDER BY created_at DESC LIMIT 100`,
      [query, `%${query}%`]
    );
    return res.json({ users: rows });
  } catch (error) { next(error); }
});

app.patch("/api/admin/users/:id/status", authenticate, adminOnly, async (req: AuthRequest, res, next) => {
  const disabled = req.body.disabled;
  if (typeof disabled !== "boolean") return badRequest(res, "Hesap durumu geçersiz.");
  if (req.params.id === req.user!.id) return badRequest(res, "Yönetici kendi hesabını devre dışı bırakamaz.");
  try {
    const { rows } = await pool.query("UPDATE users SET is_disabled = $1 WHERE id = $2 RETURNING id, is_disabled", [disabled, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    if (disabled) {
      io.to(`user:${req.params.id}`).emit("account-disabled");
      io.in(`user:${req.params.id}`).disconnectSockets(true);
    }
    return res.json({ id: rows[0].id, disabled: rows[0].is_disabled });
  } catch (error) { next(error); }
});

app.post("/api/conversations/:id/calls", authenticate, async (req: AuthRequest, res, next) => {
  const callType = req.body.type === "video" ? "video" : "audio";
  try {
    const member = await pool.query(
      `SELECT c.kind, other.user_id AS peer_id FROM conversations c
       JOIN conversation_members self ON self.conversation_id = c.id AND self.user_id = $2
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> $2
       WHERE c.id = $1`,
      [req.params.id, req.user!.id]
    );
    if (!member.rows[0] || member.rows[0].kind !== "direct") return badRequest(res, "Aramalar yalnızca bire bir sohbetlerde kullanılabilir.");
    const { rows } = await pool.query("INSERT INTO calls (conversation_id, caller_id, callee_id) VALUES ($1, $2, $3) RETURNING id, started_at", [req.params.id, req.user!.id, member.rows[0].peer_id]);
    io.to(`user:${member.rows[0].peer_id}`).emit("incoming-call", { callId: rows[0].id, conversationId: req.params.id, callerId: req.user!.id, type: callType });
    return res.status(201).json({ callId: rows[0].id, peerId: member.rows[0].peer_id });
  } catch (error) { next(error); }
});

app.post("/api/calls/:id/respond", authenticate, async (req: AuthRequest, res, next) => {
  const response = req.body.accept === true ? "accepted" : "rejected";
  try {
    const { rows } = await pool.query(
      `UPDATE calls SET status = $1, answered_at = CASE WHEN $1 = 'accepted' THEN now() ELSE answered_at END,
         ended_at = CASE WHEN $1 = 'rejected' THEN now() ELSE ended_at END
       WHERE id = $2 AND callee_id = $3 AND status = 'ringing'
       RETURNING id, conversation_id, caller_id, callee_id, status`,
      [response, req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Bekleyen arama bulunamadı." });
    io.to(`user:${rows[0].caller_id}`).emit("call-response", { callId: rows[0].id, status: response });
    return res.json({ status: response, conversationId: rows[0].conversation_id });
  } catch (error) { next(error); }
});

app.post("/api/calls/:id/end", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      "UPDATE calls SET status = 'ended', ended_at = now() WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) AND status IN ('ringing', 'accepted') RETURNING id, caller_id, callee_id, conversation_id",
      [req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Etkin arama bulunamadı." });
    const peer = rows[0].caller_id === req.user!.id ? rows[0].callee_id : rows[0].caller_id;
    io.to(`user:${peer}`).emit("call-ended", { callId: rows[0].id });
    return res.json({ status: "ended" });
  } catch (error) { next(error); }
});

app.get("/api/calls", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.started_at, c.answered_at, c.ended_at, c.conversation_id,
              u.id AS peer_id, u.display_name AS peer_name, u.username AS peer_username, u.avatar_url AS peer_avatar
       FROM calls c JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
       WHERE c.caller_id = $1 OR c.callee_id = $1 ORDER BY c.started_at DESC LIMIT 100`,
      [req.user!.id]
    );
    return res.json({ calls: rows });
  } catch (error) { next(error); }
});

if (existsSync(clientDist)) app.get("*", (_req, res) => res.sendFile(resolve(clientDist, "index.html")));

async function announcePresence(userId: string, online: boolean) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS peer_id
     FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId]
  );
  for (const { peer_id } of rows) {
    const preference = await pool.query("SELECT online_visible FROM user_settings WHERE user_id = $1", [userId]);
    if (preference.rows[0]?.online_visible) io.to(`user:${peer_id}`).emit("presence-update", { userId, online });
  }
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (typeof token !== "string") return next(new Error("Oturum açmanız gerekiyor."));
  try {
    const data = jwt.verify(token, jwtSecret!) as { sub: string; tokenVersion?: number };
    const { rows } = await pool.query("SELECT is_disabled, token_version FROM users WHERE id = $1", [data.sub]);
    if (!rows[0] || rows[0].is_disabled || rows[0].token_version !== (data.tokenVersion || 0)) return next(new Error("Oturum geçersiz veya hesap kullanılamıyor."));
    socket.data.userId = data.sub;
    const unlockToken = socket.handshake.auth.lockToken;
    if (typeof unlockToken === "string") {
      const unlocked = jwt.verify(unlockToken, jwtSecret!) as { sub: string; purpose: string; conversations: string[] };
      if (unlocked.sub === data.sub && unlocked.purpose === "locked_chats" && Array.isArray(unlocked.conversations)) socket.data.lockedConversationIds = unlocked.conversations;
    }
    next();
  } catch { next(new Error("Oturum geçersiz veya süresi dolmuş.")); }
});
io.on("connection", (socket) => {
  const userId = socket.data.userId as string;
  const userSockets = onlineUsers.get(userId) || new Set<string>();
  const wasOffline = userSockets.size === 0;
  userSockets.add(socket.id);
  onlineUsers.set(userId, userSockets);
  socket.join(`user:${userId}`);
  pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [userId]).catch((error) => console.error("Could not update last-seen status", error));
  if (wasOffline) void announcePresence(userId, true).catch((error) => console.error("Could not announce online status", error));
  socket.on("join-conversation", async (conversationId: string, callback?: (result: { ok: boolean }) => void) => {
    if (typeof conversationId !== "string") return callback?.({ ok: false });
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(cus.is_locked, false) AS is_locked FROM conversation_members cm
         LEFT JOIN conversation_user_settings cus ON cus.conversation_id = cm.conversation_id AND cus.user_id = cm.user_id
         WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
        [conversationId, userId]
      );
      if (rows[0] && (!rows[0].is_locked || (socket.data.lockedConversationIds as string[] | undefined || []).includes(conversationId))) {
        socket.join(`conversation:${conversationId}`);
        await pool.query("UPDATE message_receipts SET delivered_at = now() WHERE user_id = $1 AND message_id IN (SELECT id FROM messages WHERE conversation_id = $2) AND delivered_at IS NULL", [userId, conversationId]);
        callback?.({ ok: true });
      } else callback?.({ ok: false });
    } catch (error) { console.error("Could not join conversation", error); callback?.({ ok: false }); }
  });
  socket.on("call-signal", async (input: { callId?: string; type?: string; payload?: unknown }) => {
    if (!input || typeof input.callId !== "string" || !["offer", "answer", "ice"].includes(String(input.type)) || JSON.stringify(input.payload).length > 128_000) return;
    try {
      const { rows } = await pool.query("SELECT caller_id, callee_id FROM calls WHERE id = $1 AND status IN ('ringing', 'accepted') AND (caller_id = $2 OR callee_id = $2)", [input.callId, userId]);
      if (!rows[0]) return;
      const peerId = rows[0].caller_id === userId ? rows[0].callee_id : rows[0].caller_id;
      io.to(`user:${peerId}`).emit("call-signal", { callId: input.callId, type: input.type, payload: input.payload, from: userId });
    } catch (error) { console.error("Could not relay call signal", error); }
  });
  socket.on("disconnect", () => {
    const sockets = onlineUsers.get(userId);
    sockets?.delete(socket.id);
    if (sockets?.size === 0) {
      onlineUsers.delete(userId);
      pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [userId])
        .then(() => announcePresence(userId, false))
        .catch((error) => console.error("Could not update last-seen status", error));
    }
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("API request failed", error);
  if (error instanceof multer.MulterError) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Görsel en fazla 8 MB olabilir." : "Görsel yükleme isteği geçersiz." });
  return res.status(500).json({ error: "Sunucu isteği tamamlayamadı." });
});

async function start() {
  const port = Number(process.env.PORT || 3000);
  await pool.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  await pool.query("SELECT 1");
  if (process.env.ADMIN_PASSWORD) {
    const username = normalizedUsername(process.env.ADMIN_USERNAME || "anambabamveçayım");
    const password = process.env.ADMIN_PASSWORD;
    if (!validUsername(username) || password.length < 8) throw new Error("ADMIN_USERNAME geçerli olmalı ve ADMIN_PASSWORD en az 8 karakter olmalı.");
    const hash = await bcrypt.hash(password, 12);
    const seeded = await pool.query(
      `INSERT INTO users (phone, email, username, display_name, password_hash, is_admin)
       VALUES ('+10000000000', 'admin@zibzib.local', $1, 'ZibZib Yönetici', $2, true)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_admin = true
       WHERE users.is_admin = true
       RETURNING id`,
      [username, hash]
    );
    if (!seeded.rowCount) throw new Error("Yönetici kullanıcı adı başka bir hesaba ait; yönetici hesabı güvenli şekilde oluşturulamadı.");
    await pool.query(
      "INSERT INTO user_settings (user_id, recovery_email) SELECT id, email FROM users WHERE id = $1 ON CONFLICT (user_id) DO NOTHING",
      [seeded.rows[0].id]
    );
  }
  httpServer.listen(port, "0.0.0.0", () => console.log(`ZibZib API listening on ${port}`));
}
start().catch((error) => { console.error("ZibZib server startup failed", error); process.exitCode = 1; });
