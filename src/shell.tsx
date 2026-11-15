import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import zibzibLogo from "../zibzib.png";
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, Bell, Check, CheckCheck, ChevronDown,
  ChevronRight, CircleHelp, Clock3, ImagePlus, LockKeyhole, LogOut, MessageCircle,
  MoreHorizontal, Phone, Plus, Search, Send, Settings, Shield, SlidersHorizontal,
  Moon, Sun, UserRound, Users, Video, X
} from "lucide-react";

type Page = "login" | "register" | "profile" | "inbox" | "chat" | "settings" | "admin";
type Contact = { id: string; userId?: string; kind?: string; name: string; handle: string; initials: string; color: string; text: string; time: string; unread?: number; online?: boolean; lastSeen?: string; avatarUrl?: string; muted?: boolean; archived?: boolean; locked?: boolean; request?: "incoming" | "outgoing"; requestId?: string };
type ChatMessage = { id?: string; author: string; text: string; time: string; replyTo?: string; attachmentUrl?: string; read?: boolean; deletedForAll?: boolean; edited?: boolean };
type ActiveCall = { callId: string; type: "audio" | "video"; incoming?: boolean };

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? "brand-small" : ""}`}><img className="brand-logo" src={zibzibLogo} alt="ZibZib" />{!small && <span>ZibZib</span>}</div>;
}

function AuthLayout({ children, eyebrow, title, caption }: { children: React.ReactNode; eyebrow: string; title: React.ReactNode; caption: string }) {
  return <main className="auth-page">
    <section className="auth-aside">
      <div className="auth-brand"><Brand /></div>
      <div className="aside-copy"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{caption}</p></div>
      <div className="aside-bottom"><span>Özel sohbetler, daha sakin bir yerde.</span><span>© 2026 ZibZib</span></div>
      <div className="art-shape shape-one" /><div className="art-shape shape-two" />
    </section>
    <section className="auth-content"><div className="auth-mobile-brand"><Brand /></div>{children}</section>
  </main>;
}

function App({ page }: { page: Page }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [messageMenu, setMessageMenu] = useState<string | null>(null);
  const pointerStart = useRef<{ id: string; x: number } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState("");
  const [optionContact, setOptionContact] = useState<Contact | undefined>();
  const [inboxReload, setInboxReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState("light");
  const [chatTheme, setChatTheme] = useState("light");
  const [lockToken, setLockToken] = useState("");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [showPhotosDirectly, setShowPhotosDirectly] = useState(true);
  const [defaultAvatarUrl, setDefaultAvatarUrl] = useState("");
  const [incomingCall, setIncomingCall] = useState<{ callId: string; conversationId: string; callerId: string; type: "audio" | "video" } | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [callError, setCallError] = useState("");
  const callSocket = useRef<ReturnType<typeof io> | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingSignals = useRef<Array<{ callId: string; type: "offer" | "answer" | "ice"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }>>([]);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const navigate = useNavigate();
  const { id, tab: routeTab } = useParams();
  const tab = routeTab || "profil";
  const activeId = id || selected;
  const activeContact = contacts.find((contact) => contact.id === activeId) || { id: "", name: "Sohbet seç", handle: "Mesajlarına buradan ulaş", initials: "Z", color: "mint", text: "", time: "" };
  const filteredContacts = useMemo(() => contacts.filter((contact) => `${contact.name} ${contact.handle}`.toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr"))), [contacts, search]);
  const notify = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(""), 3200); };
  function sendCallSignal(callId: string, type: "offer" | "answer" | "ice", payload: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    callSocket.current?.emit("call-signal", { callId, type, payload });
  }
  async function handleCallSignal(signal: { callId: string; type: "offer" | "answer" | "ice"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }) {
    const connection = peerConnection.current;
    if (!connection) { pendingSignals.current.push(signal); return; }
    if (signal.type === "offer") {
      await connection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      sendCallSignal(signal.callId, "answer", answer);
    } else if (signal.type === "answer") {
      await connection.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
    } else {
      await connection.addIceCandidate(signal.payload as RTCIceCandidateInit);
    }
  }
  async function preparePeer(callId: string, type: "audio" | "video", stream?: MediaStream) {
    const media = stream || await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" });
    const connection = new RTCPeerConnection();
    peerConnection.current = connection;
    localStreamRef.current = media;
    setLocalStream(media);
    media.getTracks().forEach((track) => connection.addTrack(track, media));
    connection.onicecandidate = (event) => { if (event.candidate) sendCallSignal(callId, "ice", event.candidate.toJSON()); };
    connection.ontrack = (event) => setRemoteStream(event.streams[0]);
    const queued = pendingSignals.current.splice(0);
    for (const signal of queued) if (signal.callId === callId) await handleCallSignal(signal);
    return connection;
  }
  async function startCall(type: "audio" | "video") {
    setCallError("");
    let stream: MediaStream | null = null;
    let callId: string | null = null;
    try {
      if (!activeId || activeContact.kind !== "direct") throw new Error("Aramalar yalnızca bire bir sohbetlerde kullanılabilir.");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" });
      const response = await fetch(`/api/conversations/${activeId}/calls`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ type }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Arama başlatılamadı.");
      callId = data.callId;
      setActiveCall({ callId: data.callId, type });
      const connection = await preparePeer(data.callId, type, stream);
      stream = null;
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      sendCallSignal(data.callId, "offer", offer);
    } catch (reason) {
      stream?.getTracks().forEach((track) => track.stop());
      if (callId) void fetch(`/api/calls/${callId}/end`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } });
      closeRemoteCall();
      setCallError(reason instanceof Error ? reason.message : "Arama başlatılamadı.");
    }
  }
  async function answerCall(accept: boolean) {
    if (!incomingCall) return;
    const call = incomingCall;
    try {
      const response = await fetch(`/api/calls/${call.callId}/respond`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ accept }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Arama yanıtlanamadı.");
      setIncomingCall(null);
      if (accept) { setActiveCall({ callId: call.callId, type: call.type, incoming: true }); await preparePeer(call.callId, call.type); }
      else notify("Arama reddedildi.");
    } catch (reason) { setCallError(reason instanceof Error ? reason.message : "Arama yanıtlanamadı."); }
  }
  async function endCall() {
    const callId = activeCall?.callId;
    try {
      if (callId) {
        const response = await fetch(`/api/calls/${callId}/end`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } });
        if (!response.ok) notify("Arama kapatılırken sunucu yanıt vermedi.");
      }
    } finally {
      peerConnection.current?.close(); peerConnection.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      setLocalStream(null); setRemoteStream(null); setActiveCall(null); pendingSignals.current = [];
    }
  }
  function closeRemoteCall() {
    peerConnection.current?.close(); peerConnection.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null); setRemoteStream(null); setActiveCall(null); setIncomingCall(null); pendingSignals.current = [];
  }
  useEffect(() => { if (localVideo.current) localVideo.current.srcObject = localStream; }, [localStream]);
  useEffect(() => { if (remoteVideo.current) remoteVideo.current.srcObject = remoteStream; }, [remoteStream]);
  useEffect(() => {
    let active = true;
    void fetch("/api/public/settings").then(async (response) => {
      if (!response.ok) throw new Error("Görünüm ayarları yüklenemedi.");
      const { settings } = await response.json();
      if (!active) return;
      setDefaultAvatarUrl(settings.default_avatar_url || "");
      document.documentElement.style.setProperty("--admin-light-bg", settings.light_background || "#e2ddbb");
      document.documentElement.style.setProperty("--admin-dark-bg", settings.dark_background || "#000000");
      document.documentElement.style.setProperty("--light-chat-image", settings.light_chat_background ? `url("${String(settings.light_chat_background).replace(/["\\]/g, "")}")` : "none");
      document.documentElement.style.setProperty("--dark-chat-image", settings.dark_chat_background ? `url("${String(settings.dark_chat_background).replace(/["\\]/g, "")}")` : "none");
    }).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Görünüm ayarları yüklenemedi."));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (page === "login" || page === "register" || page === "profile") return;
    const token = localStorage.getItem("zibzib-token");
    if (!token) { navigate("/giris", { replace: true }); return; }
    if (page === "admin" && !JSON.parse(localStorage.getItem("zibzib-user") || "{}").isAdmin) { navigate("/mesajlar", { replace: true }); return; }
    let active = true;
    const inboxSocket = io({ auth: { token, ...(lockToken ? { lockToken } : {}) } });
    callSocket.current = inboxSocket;
    void fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = await response.json();
        const preferencesResponse = await fetch("/api/settings", { headers: { Authorization: `Bearer ${token}` } });
        const preferences = preferencesResponse.ok ? await preferencesResponse.json() : null;
        if (active && data?.user) { setLockEnabled(Boolean(data.user.chatLocked)); setTheme(data.user.appTheme || "light"); }
        if (active && preferences?.settings) { setShowPhotosDirectly(preferences.settings.show_photos_directly); setChatTheme(preferences.settings.chat_theme || "light"); }
        return data;
      });
    const load = async () => {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [conversationResponse, requestResponse] = await Promise.all([
          fetch("/api/conversations", { headers: { ...headers, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) } }),
          fetch("/api/friend-requests", { headers })
        ]);
        if (!conversationResponse.ok || !requestResponse.ok) throw new Error("Sohbetler yüklenemedi. Oturumunu yenileyip tekrar dene.");
        const conversationData = await conversationResponse.json();
        const requestData = await requestResponse.json();
        if (!active) return;
        const conversations: Contact[] = conversationData.conversations.map((item: { id: string; kind: string; title: string | null; peer_id: string | null; peer_name: string | null; peer_username: string | null; peer_avatar_url: string | null; avatar_url: string | null; is_muted: boolean; is_archived: boolean; is_locked: boolean; unread_count: number; last_message: string | null; last_message_at: string | null }, index: number) => {
          const name = item.kind === "self" ? "Kendime" : item.title || item.peer_name || "Sohbet";
          return { id: item.id, userId: item.peer_id || undefined, kind: item.kind, name, handle: item.kind === "self" ? "@kullaniciadi (siz)" : item.kind === "group" ? "Grup sohbeti" : item.peer_username ? `@${item.peer_username}` : "Sohbet", initials: name.split(/\s+/).slice(0, 2).map((part: string) => part[0]).join("").toLocaleUpperCase("tr"), color: ["mint", "lilac", "blue", "gold"][index % 4], avatarUrl: item.kind === "group" ? item.avatar_url || defaultAvatarUrl || undefined : item.peer_avatar_url || defaultAvatarUrl || undefined, muted: item.is_muted, archived: item.is_archived, locked: item.is_locked, unread: item.unread_count || undefined, text: item.last_message || "Henüz mesaj yok", time: item.last_message_at ? new Date(item.last_message_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "" };
        });
        const requests: Contact[] = requestData.requests.map((request: { id: string; requester_id: string; addressee_id: string; requester_name: string; requester_username: string; addressee_name: string; addressee_username: string; requester_avatar_url?: string; addressee_avatar_url?: string }) => {
          const incoming = request.addressee_id === JSON.parse(localStorage.getItem("zibzib-user") || "{}").id;
          const name = incoming ? request.requester_name : request.addressee_name;
          const username = incoming ? request.requester_username : request.addressee_username;
          return { id: `request-${request.id}`, requestId: request.id, name, handle: `@${username}`, initials: name.split(/\s+/).slice(0, 2).map((part: string) => part[0]).join("").toLocaleUpperCase("tr"), color: incoming ? "rose" : "slate", avatarUrl: (incoming ? request.requester_avatar_url : request.addressee_avatar_url) || defaultAvatarUrl || undefined, text: incoming ? "Arkadaşlık isteği gönderdi" : "İstek bekliyor", time: "", request: incoming ? "incoming" : "outgoing" };
        });
        setContacts([...requests, ...conversations]);
        void Promise.all(conversations.filter((contact) => contact.userId).map(async (contact) => {
          const presence = await fetch(`/api/users/${contact.userId}/presence`, { headers });
          if (!presence.ok) return null;
          return { id: contact.id, ...(await presence.json()) as { online: boolean; lastSeen: string | null } };
        })).then((statuses) => {
          if (!active) return;
          const byId = new Map(statuses.filter((status) => status !== null).map((status) => [status.id, status]));
          setContacts((current) => current.map((contact) => {
            const status = byId.get(contact.id);
            return status ? { ...contact, online: status.online, lastSeen: status.lastSeen ? new Date(status.lastSeen).toLocaleString("tr-TR") : undefined } : contact;
          }));
        }).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Çevrimiçi durumu alınamadı."));
        conversations.forEach((conversation) => inboxSocket.emit("join-conversation", conversation.id));
      } catch (reason) { if (active) notify(reason instanceof Error ? reason.message : "Sohbetler yüklenemedi."); }
    };
    void load();
    inboxSocket.on("friend-request", () => { notify("Yeni bir arkadaşlık isteğin var."); void load(); });
    inboxSocket.on("friend-request-response", () => { void load(); });
    inboxSocket.on("group-invitation", () => { notify("Yeni bir gruba eklendin."); void load(); });
    const expireSession = (reason: string) => {
      localStorage.removeItem("zibzib-token");
      localStorage.removeItem("zibzib-user");
      notify(reason);
      navigate("/giris", { replace: true });
    };
    inboxSocket.on("session-ended", () => expireSession("Oturum güvenlik nedeniyle sonlandırıldı."));
    inboxSocket.on("account-disabled", () => expireSession("Hesabın devre dışı bırakıldı."));
    inboxSocket.on("incoming-call", (call: { callId: string; conversationId: string; callerId: string; type: "audio" | "video" }) => { setIncomingCall(call); navigate(`/sohbet/${call.conversationId}`); });
    inboxSocket.on("call-signal", (signal: { callId: string; type: "offer" | "answer" | "ice"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }) => {
      void handleCallSignal(signal).catch((reason: unknown) => setCallError(reason instanceof Error ? reason.message : "Arama sinyali işlenemedi."));
    });
    inboxSocket.on("call-ended", () => closeRemoteCall());
    inboxSocket.on("presence-update", (status: { userId: string; online: boolean }) => {
      setContacts((current) => current.map((contact) => contact.userId === status.userId ? { ...contact, online: status.online } : contact));
    });
    inboxSocket.on("message", (item: { conversation_id: string; sender_id: string; body: string | null; attachment_url?: string | null; created_at: string }) => {
      if (!active) return;
      setContacts((current) => [...current].map((contact) => contact.id === item.conversation_id
        ? { ...contact, text: item.attachment_url ? "Fotoğraf" : item.body || "Bu mesaj silindi", unread: activeId !== item.conversation_id && item.sender_id !== JSON.parse(localStorage.getItem("zibzib-user") || "{}").id ? (contact.unread || 0) + 1 : contact.unread, time: new Date(item.created_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) }
        : contact).sort((a, b) => b.time.localeCompare(a.time, "tr")));
    });
    inboxSocket.on("message-deleted", (item: { id: string; deletedForAll: boolean; conversationId?: string }) => {
      if (item.deletedForAll && item.conversationId) setContacts((current) => current.map((contact) => contact.id === item.conversationId ? { ...contact, text: "Bu mesaj silindi" } : contact));
    });
    return () => { active = false; inboxSocket.disconnect(); if (callSocket.current === inboxSocket) callSocket.current = null; };
  }, [page, navigate, inboxReload, lockToken, defaultAvatarUrl, activeId]);

  useEffect(() => {
    const token = localStorage.getItem("zibzib-token");
    const user = JSON.parse(localStorage.getItem("zibzib-user") || "{}");
    if (!token || !activeId || activeId.startsWith("request-")) { setMessages([]); return; }
    let active = true;
    const socket = io({ auth: { token, ...(lockToken ? { lockToken } : {}) } });
    const toMessage = (item: { id?: string; sender_id?: string; body?: string; attachment_url?: string | null; created_at?: string; reply_to?: string | null; deleted_for_all?: boolean; edited_at?: string | null; read_by_peer?: boolean }) => ({
      id: item.id,
      author: item.sender_id === user.id ? "me" : "them",
      text: item.deleted_for_all ? "Bu mesaj silindi" : item.body || "Bu mesaj silindi",
      time: item.created_at ? new Date(item.created_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "",
      replyTo: item.reply_to || undefined,
      attachmentUrl: item.attachment_url || undefined,
      read: item.read_by_peer || false,
      deletedForAll: item.deleted_for_all || false,
      edited: Boolean(item.edited_at)
    });
    fetch(`/api/conversations/${activeId}/messages`, { headers: { Authorization: `Bearer ${token}`, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) } })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Mesajlar yüklenemedi.");
        if (active) {
          setMessages(data.messages.map(toMessage));
          void fetch(`/api/conversations/${activeId}/read`, { method: "POST", headers: { Authorization: `Bearer ${token}`, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) } }).then((response) => { if (!response.ok) throw new Error("Okundu bilgisi gönderilemedi."); setContacts((current) => current.map((contact) => contact.id === activeId ? { ...contact, unread: undefined } : contact)); }).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Okundu bilgisi gönderilemedi."));
        }
      }).catch((reason: unknown) => { if (active) notify(reason instanceof Error ? reason.message : "Mesajlar yüklenemedi."); });
    socket.on("connect", () => socket.emit("join-conversation", activeId));
    socket.on("message", (item: { id: string; sender_id: string; body: string; created_at: string; reply_to?: string | null }) => {
      if (active) setMessages((items) => items.some((messageItem) => messageItem.id === item.id) ? items : [...items, toMessage(item)]);
    });
    socket.on("message-edited", (item: { id: string; sender_id: string; body: string; created_at: string; edited_at: string }) => {
      if (active) setMessages((items) => items.map((messageItem) => messageItem.id === item.id ? { ...messageItem, text: item.body, edited: true } : messageItem));
    });
    socket.on("message-deleted", (item: { id: string; deletedForAll: boolean }) => {
      if (!active) return;
      setMessages((items) => item.deletedForAll
        ? items.map((messageItem) => messageItem.id === item.id ? { ...messageItem, text: "Bu mesaj silindi", deletedForAll: true } : messageItem)
        : items.filter((messageItem) => messageItem.id !== item.id));
    });
    socket.on("read-receipt", (item: { userId: string; messageIds: string[] }) => {
      if (active && item.userId !== user.id) setMessages((current) => current.map((messageItem) => item.messageIds.includes(messageItem.id || "") ? { ...messageItem, read: true } : messageItem));
    });
    return () => { active = false; socket.disconnect(); };
  }, [activeId, lockToken]);

  if (page === "login") return <Login notify={notify} />;
  if (page === "register") return <Register />;
  if (page === "profile") return <ProfileSetup notify={notify} />;
  if (page === "settings") return <div className={`app-shell ${theme}`}><Sidebar navigate={navigate} notify={notify} /><SettingsPage activeTab={tab} setActiveTab={(value) => navigate(`/ayarlar/${value}`)} theme={theme} setTheme={setTheme} setChatTheme={setChatTheme} notify={notify} defaultAvatarUrl={defaultAvatarUrl} /><nav className="mobile-nav"><button onClick={() => navigate("/mesajlar")}><Phone /><span>Aramalar</span></button><button onClick={() => navigate("/mesajlar")}><MessageCircle /><span>Mesajlar</span></button><button className="active" onClick={() => navigate("/ayarlar/profil")}><Settings /><span>Ayarlar</span></button></nav></div>;
  if (page === "admin") return <div className={`app-shell ${theme}`}><Sidebar navigate={navigate} notify={notify} /><AdminPage notify={notify} /><nav className="mobile-nav"><button onClick={() => navigate("/mesajlar")}><Phone /><span>Aramalar</span></button><button onClick={() => navigate("/mesajlar")}><MessageCircle /><span>Mesajlar</span></button><button className="active" onClick={() => navigate("/ayarlar/profil")}><Settings /><span>Ayarlar</span></button></nav></div>;
  const showChat = page === "chat";

  function chooseChat(contact: Contact) {
    if (contact.request) return;
    setSelected(contact.id);
    navigate(`/sohbet/${contact.id}`);
  }
  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || !activeId) return;
    const body = message.trim();
    const token = localStorage.getItem("zibzib-token");
    const isEditing = Boolean(editingMessage?.id);
    const url = isEditing ? `/api/messages/${editingMessage!.id}` : `/api/conversations/${activeId}/messages`;
    void fetch(url, { method: isEditing ? "PATCH" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) }, body: JSON.stringify({ body, replyTo: replyTarget?.id }) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || (isEditing ? "Mesaj düzenlenemedi." : "Mesaj gönderilemedi."));
        if (isEditing) {
          setMessages((current) => current.map((item) => item.id === data.message.id ? { ...item, text: data.message.body, edited: true } : item));
          setEditingMessage(null);
        } else {
          setMessages((current) => current.some((item) => item.id === data.message.id) ? current : [...current, { id: data.message.id, author: "me", text: data.message.body, time: new Date(data.message.created_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }), replyTo: data.message.reply_to || undefined, read: false }]);
          setReplyTarget(null);
          setContacts((current) => current.map((item) => item.id === activeId ? { ...item, text: body, time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) } : item));
        }
      }).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Mesaj gönderilemedi."));
    setMessage("");
  }
  async function deleteMessage(item: ChatMessage, everyone: boolean) {
    if (!item.id) return;
    try {
      const response = await fetch(`/api/messages/${item.id}?everyone=${everyone}`, { method: "DELETE", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}`, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Mesaj silinemedi.");
      setMessages((current) => everyone
        ? current.map((messageItem) => messageItem.id === item.id ? { ...messageItem, text: "Bu mesaj silindi", deletedForAll: true } : messageItem)
        : current.filter((messageItem) => messageItem.id !== item.id));
      setMessageMenu(null);
    } catch (reason) { notify(reason instanceof Error ? reason.message : "Mesaj silinemedi."); }
  }
  async function respondToRequest(contact: Contact, accept: boolean) {
    const token = localStorage.getItem("zibzib-token");
    try {
      const response = await fetch(`/api/friend-requests/${contact.requestId}/respond`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ accept }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "İstek yanıtlanamadı.");
      if (!accept) setContacts((current) => current.filter((item) => item.id !== contact.id));
      else {
        setContacts((current) => current.filter((item) => item.id !== contact.id));
        if (data.conversationId) navigate(`/sohbet/${data.conversationId}`);
      }
      notify(accept ? `${contact.name} ile artık arkadaşsınız.` : "İstek reddedildi.");
    } catch (reason) { notify(reason instanceof Error ? reason.message : "İstek yanıtlanamadı."); }
  }

  return <div className={`app-shell ${theme}`}>
    <aside className="rail">
      <div className="rail-brand"><Brand small /></div>
      <button className="rail-button active" title="Mesajlar" onClick={() => navigate("/mesajlar")}><MessageCircle /></button>
      <button className="rail-button" title="Aramalar" onClick={() => setModal("Aramalar")}><Phone /></button>
      <div className="rail-spacer" />
      <button className="rail-button" title="Ayarlar" onClick={() => navigate("/ayarlar/profil")}><Settings /></button>
      <button className="rail-avatar" title="Profil ayarları" onClick={() => navigate("/ayarlar/profil")}>KA</button>
    </aside>
    <section className={`inbox ${showChat ? "inbox-mobile-hidden" : ""}`}>
      <header className="inbox-header">
        <div className="header-brand"><Brand /><button className="icon-btn subtle" aria-label="Menü"><MoreHorizontal /></button></div>
        <h1>Mesajlar</h1>
        <label className="searchbox"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "Enter" || !lockEnabled || !search) return;
          event.preventDefault();
          void fetch("/api/profile/lock/verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ code: search }) })
            .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Kilitli sohbetler açılamadı."); setLockToken(data.token); setSearch(""); notify("Kilitli sohbetler bu oturum için açıldı."); })
            .catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Kilit açılamadı."));
        }} placeholder={lockEnabled ? "Kişi ara veya kilit kodunu gir" : "Kişi ara"} /><kbd>↵</kbd></label>
        <div className="inbox-tools"><button onClick={() => setModal("Kendinize mesaj gönderin")}><UserRound /> Kendime mesaj</button><button onClick={() => setModal("Grup oluştur")}><Users /> Grup oluştur</button><button onClick={() => setModal("Toplu mesaj")}><Send /> Toplu mesaj</button>{lockToken && <button onClick={() => { setLockToken(""); notify("Kilitli sohbetler kapatıldı."); }}>Kilitli sohbetleri kapat</button>}</div>
      </header>
      <div className="section-label"><span>SON SOHBETLER</span><button aria-label="Arşivlenmiş sohbetler" onClick={() => setModal("Arşivlenmiş sohbetler")}><SlidersHorizontal size={15} /></button></div>
      <div className="contact-list">
        {filteredContacts.map((contact) => <ContactRow key={contact.id} contact={contact} selected={activeId === contact.id} onClick={() => chooseChat(contact)} onAction={() => { setOptionContact(contact); setModal("Sohbet seçenekleri"); }} onAccept={() => void respondToRequest(contact, true)} onReject={() => void respondToRequest(contact, false)} />)}
        {filteredContacts.length === 0 && <div className="search-empty"><p>{search ? "Bu isimle eşleşen kişi bulunamadı." : "Henüz mesajın yok."}</p><button className="text-button" onClick={() => setModal("Kullanıcı ara")}>Kullanıcı ara veya arkadaş ekle</button></div>}
      </div>
      <button className="floating-add" onClick={() => setModal("Yeni sohbet")} aria-label="Yeni sohbet"><Plus /></button>
      <div className="inbox-footer"><span className="secure-dot" /> Sohbetlerin senin kontrolünde <button onClick={() => navigate("/ayarlar/gizlilik")}>Gizlilik</button></div>
    </section>
    <main className={`conversation ${showChat ? "conversation-mobile-visible" : ""}`}>
      <header className="conversation-header">
        <button className="back-mobile icon-btn" onClick={() => navigate("/mesajlar")} aria-label="Sohbet listesine dön"><ArrowLeft /></button>
        <Avatar contact={activeContact} />
        <div className="conversation-person"><strong>{activeContact.name}</strong><span>{activeContact.online ? <><i className="online-dot" /> çevrimiçi</> : activeContact.lastSeen ? `son görülme ${activeContact.lastSeen}` : activeContact.handle}</span></div>
        <div className="conversation-actions"><button className="icon-btn" title="Sesli ara" onClick={() => void startCall("audio")}><Phone /></button><button className="icon-btn" title="Görüntülü ara" onClick={() => void startCall("video")}><Video /></button><button className="icon-btn" title="Sohbet seçenekleri" onClick={() => { setOptionContact(activeContact); setModal("Sohbet seçenekleri"); }}><MoreHorizontal /></button></div>
      </header>
      <div className={`chat-background ${chatTheme === "dark" ? "chat-theme-dark" : ""}`}>
        <div className="day-divider"><span>BUGÜN</span></div>
        {activeId && <div className="friend-note"><Check size={14} /> Bu kişiyle artık arkadaşsınız</div>}
        {!activeId && <div className="empty-chat"><div className="empty-chat-icon"><MessageCircle /></div><h2>{contacts.length ? "Sohbetini seç" : "Henüz hiç mesajın yok"}</h2><p>{contacts.length ? "Bir sohbet seç veya yeni bir konuşma başlat." : "İlk sohbetini başlatmak için bir kullanıcı ara."}</p>{!contacts.length && <button className="text-button" onClick={() => setModal("Kullanıcı ara")}>Kullanıcı ara <ArrowRight size={14} /></button>}</div>}
        {messages.map((item, index) => <div key={item.id || `${item.time}-${index}`} className={`message-line ${item.author === "me" ? "mine" : ""}`} onContextMenu={(event) => { if (!item.deletedForAll) { event.preventDefault(); setMessageMenu(item.id || null); } }} onPointerDown={(event) => { if (item.id && !item.deletedForAll) { pointerStart.current = { id: item.id, x: event.clientX }; holdTimer.current = window.setTimeout(() => setMessageMenu(item.id || null), 550); } }} onPointerUp={(event) => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current); holdTimer.current = null; const start = pointerStart.current; pointerStart.current = null; if (start && start.id === item.id && (item.author === "them" ? event.clientX - start.x > 55 : start.x - event.clientX > 55)) setReplyTarget(item); }}>
          {item.author !== "me" && <Avatar contact={activeContact} mini />}
          <div className="bubble" onDoubleClick={() => { if (item.author === "me" && item.id && !item.deletedForAll) { setEditingMessage(item); setMessage(item.text); setReplyTarget(null); } }}><span>{item.replyTo && <small className="reply-reference">Yanıtlanan mesaj</small>}{item.attachmentUrl && (showPhotosDirectly ? <a href={item.attachmentUrl} target="_blank" rel="noreferrer"><img className="message-image" src={item.attachmentUrl} alt="Sohbette paylaşılan görsel" /></a> : <a className="hidden-photo-link" href={item.attachmentUrl} target="_blank" rel="noreferrer">Fotoğrafı aç</a>)}{item.text}{item.edited && <small className="edited-label"> · düzenlendi</small>}</span><div className="bubble-meta">{item.time}{item.author === "me" && <CheckCheck size={14} />}</div>{messageMenu === item.id && <div className="message-actions" onPointerDown={(event) => event.stopPropagation()}><button onClick={() => { setReplyTarget(item); setMessageMenu(null); }}>Yanıtla</button>{item.author === "me" && !item.deletedForAll && <button onClick={() => { setEditingMessage(item); setMessage(item.text); setMessageMenu(null); }}>Düzenle</button>}<button onClick={() => void deleteMessage(item, item.author === "me" && activeContact.kind !== "self")}>Benden sil</button>{item.author === "me" && activeContact.kind !== "self" && <button className="danger-action" onClick={() => void deleteMessage(item, true)}>Herkesten sil</button>}</div>}</div>
        </div>)}
      </div>
      <form className="composer" onSubmit={sendMessage}>
        {(replyTarget || editingMessage) && <div className="composer-context"><span>{editingMessage ? "Mesajı düzenle" : `Yanıtlanıyor: ${replyTarget?.text.slice(0, 60)}`}</span><button type="button" onClick={() => { setReplyTarget(null); setEditingMessage(null); setMessage(""); }} aria-label="Yanıtı kapat"><X size={14} /></button></div>}
        <label className="icon-btn attach-image-button" aria-label="Fotoğraf ekle"><ImagePlus /><input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !activeId) return;
          const body = new FormData();
          body.append("image", file);
          try {
            const response = await fetch(`/api/conversations/${activeId}/messages/image`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}`, ...(lockToken ? { "X-Chat-Unlock": lockToken } : {}) }, body });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Fotoğraf gönderilemedi.");
            const item = data.message;
            setMessages((current) => [...current, { id: item.id, author: "me", text: "", attachmentUrl: item.attachment_url, time: new Date(item.created_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) }]);
          } catch (reason) { notify(reason instanceof Error ? reason.message : "Fotoğraf gönderilemedi."); }
        }} /></label>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={editingMessage ? "Mesajı düzenle..." : "Bir mesaj yaz..."} aria-label="Mesajınız" />
        <button className="send-button" type="submit" aria-label="Mesaj gönder" disabled={!activeId}><Send size={18} /></button>
      </form>
    </main>
    <nav className="mobile-nav">
      <button onClick={() => setModal("Aramalar")}><Phone /><span>Aramalar</span></button>
      <button className="active" onClick={() => navigate("/mesajlar")}><MessageCircle /><span>Mesajlar</span></button>
      <button onClick={() => navigate("/ayarlar/profil")}><Settings /><span>Ayarlar</span></button>
    </nav>
    {notice && <div className="toast"><Check size={16} />{notice}</div>}
    {callError && <div className="toast" role="alert">{callError}<button onClick={() => setCallError("")}>Kapat</button></div>}
    {incomingCall && <div className="incoming-call-card"><strong>Gelen {incomingCall.type === "video" ? "görüntülü" : "sesli"} arama</strong><span>Arkadaşın seni arıyor.</span><div><button className="primary-button" onClick={() => void answerCall(true)}>Yanıtla</button><button className="outline-button" onClick={() => void answerCall(false)}>Reddet</button></div></div>}
    {activeCall && <div className="call-overlay"><div className="call-window"><header><strong>{activeContact.name}</strong><span>{remoteStream ? "Bağlandı" : "Bağlanıyor..."}</span></header><video ref={remoteVideo} autoPlay playsInline className="remote-video" /><video ref={localVideo} autoPlay muted playsInline className="local-video" /><button className="end-call-button" onClick={() => void endCall()}>Aramayı bitir</button></div></div>}
    {modal && <Modal title={modal} close={() => setModal("")} notify={notify} onChange={() => setInboxReload((value) => value + 1)} contacts={contacts} navigate={navigate} selectedContact={optionContact} defaultAvatarUrl={defaultAvatarUrl} />}
  </div>;
}

function ContactRow({ contact, selected, onClick, onAction, onAccept, onReject }: { contact: Contact; selected: boolean; onClick: () => void; onAction: () => void; onAccept: () => void; onReject: () => void }) {
  return <div className={`contact-row ${selected ? "selected" : ""}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onClick(); }}>
    <Avatar contact={contact} />
    <div className="contact-copy"><div className="contact-title"><strong>{contact.name}</strong><time>{contact.time}</time></div><div className="contact-preview"><span>{contact.text}</span>{contact.unread && <b>{contact.unread}</b>}</div>
      {contact.request === "incoming" && <div className="request-actions" onClick={(event) => event.stopPropagation()}><button onClick={onAccept}>Kabul et</button><button onClick={onReject}>Reddet</button></div>}
      {contact.request === "outgoing" && <span className="pending-label"><Clock3 size={12} /> İstek bekliyor</span>}
    </div><button className="row-more" aria-label="Sohbet seçenekleri" onClick={(event) => { event.stopPropagation(); onAction(); }}><MoreHorizontal size={17} /></button>
  </div>;
}

function Avatar({ contact, mini = false }: { contact: Contact; mini?: boolean }) {
  return <div className={`avatar ${contact.color} ${mini ? "avatar-mini" : ""}`}>{contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : contact.initials}{contact.online && <i />}</div>;
}

function Login({ notify }: { notify: (text: string) => void }) {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<{ token: string; method: string; question: string | null } | null>(null);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState("");
  return <AuthLayout eyebrow="DAHA YAKIN, DAHA SADE" title={<>Sohbetin en<br />iyi hali.</>} caption="Günün içinden küçük bir merhaba, uzun bir sohbet. ZibZib'de iletişim sana ait.">
    <div className="auth-form">
      <div className="form-heading"><p className="eyebrow">HOŞ GELDİN</p><h2>Hesabına giriş yap</h2><p>Devam etmek için bilgilerini gir.</p></div>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        setError("");
        try {
          const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: values.get("username"), password: values.get("password") }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Giriş yapılamadı.");
          if (data.requiresTwoFactor) { setChallenge({ token: data.challenge, method: data.method, question: data.question }); return; }
          localStorage.setItem("zibzib-token", data.token);
          localStorage.setItem("zibzib-user", JSON.stringify(data.user));
          navigate(data.user.isAdmin ? "/yonetim" : "/mesajlar");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Sunucuya bağlanılamadı."); }
      }}>
        {!challenge ? <><label>Kullanıcı adı<input name="username" autoComplete="username" placeholder="kullaniciadi" required /></label>
        <label>Şifre<input name="password" type="password" autoComplete="current-password" placeholder="Şifren" required /></label>
        <div className="form-inline"><label className="check-label"><input type="checkbox" /> Beni hatırla</label><button type="button" className="text-button" onClick={() => { setResetMode(true); setResetError(""); }}>Şifremi unuttum</button></div>
        <button className="primary-button full-button" type="submit">Giriş yap <ArrowRight size={17} /></button></> :
          <div className="two-factor-prompt"><p>{challenge.method === "email" ? "E-posta adresine gönderilen 6 haneli kodu gir." : challenge.method === "pin" ? "6 haneli PIN kodunu gir." : challenge.question || "Güvenlik sorusunun yanıtını gir."}</p><label>Doğrulama yanıtı<input id="two-factor-answer" autoFocus inputMode={challenge.method === "email" || challenge.method === "pin" ? "numeric" : undefined} /></label><button className="primary-button full-button" type="button" onClick={async () => {
            try {
              const answer = (document.getElementById("two-factor-answer") as HTMLInputElement).value;
              const response = await fetch("/api/auth/verify-2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: challenge.token, answer }) });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Doğrulama başarısız.");
              localStorage.setItem("zibzib-token", data.token); localStorage.setItem("zibzib-user", JSON.stringify(data.user));
              navigate(data.user.isAdmin ? "/yonetim" : "/mesajlar");
            } catch (reason) { setError(reason instanceof Error ? reason.message : "Doğrulama başarısız."); }
          }}>Doğrula <ArrowRight size={17} /></button><button type="button" className="text-button" onClick={() => { setChallenge(null); setError(""); }}>Geri</button></div>}
      </form>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {resetMode && <div className="reset-panel"><div className="form-heading"><h2>Şifre sıfırlama</h2><p>E-posta adresinle kod al ve yeni şifre belirle.</p></div><form onSubmit={async (event) => {
        event.preventDefault(); setResetError("");
        const values = new FormData(event.currentTarget);
        const payload = resetSent ? { email: values.get("resetEmail"), code: values.get("resetCode"), password: values.get("resetPassword") } : { email: values.get("resetEmail") };
        try {
          const response = await fetch(`/api/auth/password-reset/${resetSent ? "finish" : "start"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
          const data = await response.json(); if (!response.ok) throw new Error(data.error || "İstek tamamlanamadı.");
          if (resetSent) { setResetMode(false); setResetSent(false); notify(data.message); } else { setResetSent(true); notify(data.message); }
        } catch (reason) { setResetError(reason instanceof Error ? reason.message : "İstek tamamlanamadı."); }
      }}><label>E-posta<input name="resetEmail" type="email" required /></label>{resetSent && <><label>6 haneli kod<input name="resetCode" inputMode="numeric" maxLength={6} required /></label><label>Yeni şifre<input name="resetPassword" type="password" minLength={8} required /></label></>}<button className="primary-button full-button" type="submit">{resetSent ? "Şifreyi yenile" : "Kod gönder"}</button></form>{resetError && <p className="auth-error">{resetError}</p>}<button className="text-button" onClick={() => { setResetMode(false); setResetSent(false); }}>Kapat</button></div>}
      <div className="auth-divider"><span>Hesabın yok mu?</span></div>
      <Link to="/kayit" className="secondary-button full-button">Yeni hesap oluştur</Link>
      <button className="admin-entry" onClick={() => setAdmin((value) => !value)}><Shield size={15} /> Yönetici girişi</button>
      {admin && <div className="admin-hint">Yönetici hesabı için kullanıcı adı ve parola ile giriş yapın. Girişten sonra yönetim paneli açılır.</div>}
      <p className="legal-copy">Devam ederek <a href="#">Kullanım Koşulları</a> ve <a href="#">Gizlilik İlkeleri</a>'ni kabul etmiş olursun.</p>
    </div>
  </AuthLayout>;
}

function Register() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  return <AuthLayout eyebrow="ZIBZIB'A KATIL" title={<>Kendi çevren,<br />kendi alanın.</>} caption="Hesabını birkaç adımda oluştur. Telefon numaran ve e-posta adresin hesabını korumaya yardımcı olur.">
    <div className="auth-form">
      <div className="form-heading"><p className="eyebrow">01 / 02</p><h2>Hesabını oluştur</h2><p>İletişim ve giriş bilgilerini ekle.</p></div>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        if (values.get("password") !== values.get("confirmPassword")) { setError("Şifreler birbiriyle eşleşmiyor."); return; }
        navigate("/kurulum", { state: { phone: `+90${String(values.get("phone")).replace(/\D/g, "")}`, email: values.get("email"), password: values.get("password") } });
      }}>
        <label>Telefon numarası<div className="phone-input"><span>+90</span><input name="phone" type="tel" placeholder="5XX XXX XX XX" required /></div></label>
        <label>E-posta adresi<input name="email" type="email" placeholder="ornek@eposta.com" required /></label>
        <label>Şifre<input name="password" type="password" minLength={8} placeholder="En az 8 karakter" required /></label>
        <label>Şifreyi tekrar gir<input name="confirmPassword" type="password" minLength={8} placeholder="Şifreni doğrula" required /></label>
        <button className="primary-button full-button" type="submit">Devam et <ArrowRight size={17} /></button>
      </form>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p className="form-bottom">Zaten hesabın var mı? <Link to="/giris">Giriş yap</Link></p>
    </div>
  </AuthLayout>;
}

async function uploadCroppedAvatar(file: File, horizontalPosition: number, token: string) {
  const image = await createImageBitmap(file);
  const size = Math.min(image.width, image.height);
  const sourceX = (image.width - size) * horizontalPosition / 100;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Fotoğraf düzenleyicisi başlatılamadı.");
  context.drawImage(image, sourceX, (image.height - size) / 2, size, size, 0, 0, canvas.width, canvas.height);
  image.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Fotoğraf işlenemedi.")), "image/jpeg", 0.9));
  const body = new FormData();
  body.append("image", new File([blob], "profile.jpg", { type: "image/jpeg" }));
  const response = await fetch("/api/profile/avatar", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Profil fotoğrafı yüklenemedi.");
  localStorage.setItem("zibzib-user", JSON.stringify({ ...JSON.parse(localStorage.getItem("zibzib-user") || "{}"), avatarUrl: data.avatarUrl }));
}

function ProfileSetup({ notify }: { notify: (text: string) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const registration = location.state as { phone?: string; email?: string; password?: string } | null;
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [photoPosition, setPhotoPosition] = useState(50);
  return <AuthLayout eyebrow="02 / 02" title={<>Seni nasıl<br />tanıyalım?</>} caption="İsmini ve kullanıcı adını seç. Profil fotoğrafını istediğin zaman ekleyebilirsin.">
    <div className="auth-form">
      <div className="form-heading"><p className="eyebrow">PROFİLİNİ HAZIRLA</p><h2>Biraz kendinden bahset</h2><p>Adın arkadaşlarına görünecek.</p></div>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!registration?.phone || !registration.email || !registration.password) { setError("Kayıt adımı bulunamadı. Lütfen yeniden kayıt olun."); return; }
        const values = new FormData(event.currentTarget);
        setError("");
        try {
          const response = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...registration, displayName: values.get("displayName"), username: values.get("username") }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Kayıt tamamlanamadı.");
          localStorage.setItem("zibzib-token", data.token);
          localStorage.setItem("zibzib-user", JSON.stringify(data.user));
          if (photo) {
            try { await uploadCroppedAvatar(photo, photoPosition, data.token); }
            catch (reason) { notify(reason instanceof Error ? reason.message : "Profil fotoğrafı yüklenemedi."); }
          }
          navigate("/mesajlar");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Sunucuya bağlanılamadı."); }
      }}>
        <div className="profile-picture-picker"><div className="profile-placeholder">{photoPreview ? <img src={photoPreview} alt="Profil fotoğrafı önizlemesi" style={{ objectPosition: `${photoPosition}% center` }} /> : "Z"}</div><label className="picture-upload"><ImagePlus size={16} /> Fotoğraf ekle<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 8 * 1024 * 1024) { setError("Fotoğraf en fazla 8 MB olabilir."); return; } setPhoto(file); setPhotoPreview(URL.createObjectURL(file)); }} /></label>{photoPreview && <label className="crop-control">Fotoğrafı ortala<input type="range" min="0" max="100" value={photoPosition} onChange={(event) => setPhotoPosition(Number(event.target.value))} /></label>}<small>İsteğe bağlı · Profil fotoğrafı daire içinde görünür</small></div>
        <label>Görünen isim<input name="displayName" maxLength={40} placeholder="Adın ve soyadın" required /><small>2–40 karakter</small></label>
        <label>Kullanıcı adı<div className="username-input"><span>@</span><input name="username" minLength={3} maxLength={24} pattern="[a-z0-9._çğıöşü]+" placeholder="kullaniciadi" required /></div><small>3–24 karakter, küçük harf ve rakam. Kullanıcı adı benzersiz olmalı.</small></label>
        <button className="primary-button full-button" type="submit">ZibZib'ı kullanmaya başla <ArrowRight size={17} /></button>
      </form>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p className="form-bottom"><button className="text-button" onClick={() => navigate("/kayit")}><ArrowLeft size={14} /> Geri dön</button></p>
    </div>
  </AuthLayout>;
}

function Sidebar({ navigate, notify }: { navigate: (path: string) => void; notify: (message: string) => void }) {
  const user = JSON.parse(localStorage.getItem("zibzib-user") || "{}");
  async function logout() {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } });
      if (!response.ok) throw new Error("Sunucu oturumu kapatamadı.");
    } catch (reason) { notify(reason instanceof Error ? reason.message : "Sunucuda oturum kapatılamadı."); }
    finally { localStorage.removeItem("zibzib-token"); localStorage.removeItem("zibzib-user"); navigate("/giris"); }
  }
  return <aside className="settings-sidebar"><button className="settings-brand" onClick={() => navigate("/mesajlar")}><Brand /></button><p className="side-label">ÇALIŞMA ALANI</p><button className="side-link" onClick={() => navigate("/mesajlar")}><MessageCircle /> Mesajlar <ChevronRight /></button><p className="side-label side-spaced">HESAP</p><button className="side-link active" onClick={() => navigate("/ayarlar/profil")}><Settings /> Ayarlar <ChevronRight /></button><button className="side-link" onClick={() => void logout()}><LogOut /> Oturumu kapat</button><div className="sidebar-bottom"><div className="mini-profile"><div className="avatar mint">{(user.displayName || "Z").split(/\s+/).slice(0, 2).map((part: string) => part[0]).join("").toLocaleUpperCase("tr")}</div><span><strong>{user.displayName || "ZibZib kullanıcısı"}</strong><small>@{user.username || "kullaniciadi"}</small></span><ChevronDown size={16} /></div><button className="back-to-chat" onClick={() => navigate("/mesajlar")}><ArrowLeft size={15} /> Sohbetlere dön</button></div></aside>;
}

function SettingsPage({ activeTab, setActiveTab, theme, setTheme, setChatTheme, notify, defaultAvatarUrl }: { activeTab: string; setActiveTab: (tab: string) => void; theme: string; setTheme: (theme: string) => void; setChatTheme: (theme: string) => void; notify: (text: string) => void; defaultAvatarUrl: string }) {
  const [user, setUser] = useState<{ displayName: string; username: string; email: string; avatarUrl: string; recoveryEmail: string; twoFactorType: string; securityQuestion: string; chatLocked: boolean }>({ displayName: "", username: "", email: "", avatarUrl: "", recoveryEmail: "", twoFactorType: "", securityQuestion: "", chatLocked: false });
  const [prefs, setPrefs] = useState({ last_seen_visible: true, online_visible: true, read_receipts: true, show_photos_directly: true, app_theme: "light", chat_theme: "light" });
  const [dialog, setDialog] = useState("");
  const [error, setError] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileUsername, setProfileUsername] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailPending, setEmailPending] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [twoFactorMethod, setTwoFactorMethod] = useState("none");
  const [question, setQuestion] = useState("En sevdiğin isim");
  const [answer, setAnswer] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [pin, setPin] = useState("");
  const [lockCode, setLockCode] = useState("");
  const [lockPassword, setLockPassword] = useState("");
  const [lockRecoveryPending, setLockRecoveryPending] = useState(false);
  const [lockRecoveryCode, setLockRecoveryCode] = useState("");
  const [passwordOld, setPasswordOld] = useState("");
  const [passwordNew, setPasswordNew] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const token = localStorage.getItem("zibzib-token") || "";
  const authHeaders = { Authorization: `Bearer ${token}` };
  async function request(url: string, method = "GET", data?: unknown) {
    const response = await fetch(url, { method, headers: data === undefined ? authHeaders : { ...authHeaders, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "İstek tamamlanamadı.");
    return result;
  }
  useEffect(() => {
    let active = true;
    Promise.all([request("/api/me"), request("/api/settings")]).then(([profile, settings]) => {
      if (!active) return;
      const current = profile.user;
      setUser({ displayName: current.displayName, username: current.username, email: current.email, avatarUrl: current.avatarUrl || "", recoveryEmail: current.recoveryEmail || current.email, twoFactorType: current.twoFactorType || "", securityQuestion: current.securityQuestion || "", chatLocked: current.chatLocked });
      setProfileName(current.displayName);
      setProfileUsername(current.username);
      setRecoveryEmail(current.recoveryEmail || current.email);
      setPrefs(settings.settings);
      setTheme(current.appTheme || "light");
      setChatTheme(current.chatTheme || "light");
    }).catch((reason: unknown) => { if (active) notify(reason instanceof Error ? reason.message : "Ayarlar yüklenemedi."); });
    return () => { active = false; };
  }, []);
  async function saveProfile() {
    try {
      const result = await request("/api/profile", "PATCH", { displayName: profileName, username: profileUsername });
      setUser((current) => ({ ...current, displayName: result.user.displayName, username: result.user.username }));
      const stored = JSON.parse(localStorage.getItem("zibzib-user") || "{}");
      localStorage.setItem("zibzib-user", JSON.stringify({ ...stored, username: result.user.username, displayName: result.user.displayName }));
      notify("Profilin güncellendi.");
    } catch (reason) { notify(reason instanceof Error ? reason.message : "Profil kaydedilemedi."); }
  }
  async   function updatePref(key: keyof typeof prefs, value: boolean | string) {
    const previous = prefs[key];
    setPrefs((current) => ({ ...current, [key]: value }));
    try {
      await request("/api/settings", "PATCH", { [key]: value });
      if (key === "app_theme" && typeof value === "string") setTheme(value);
      if (key === "chat_theme" && typeof value === "string") setChatTheme(value);
    } catch (reason) {
      setPrefs((current) => ({ ...current, [key]: previous }));
      notify(reason instanceof Error ? reason.message : "Ayar kaydedilemedi.");
    }
  }
  async function uploadAvatar(file: File) {
    const body = new FormData();
    body.append("image", file);
    const response = await fetch("/api/profile/avatar", { method: "POST", headers: authHeaders, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Fotoğraf yüklenemedi.");
    setUser((current) => ({ ...current, avatarUrl: data.avatarUrl }));
    notify("Profil fotoğrafın güncellendi.");
  }
  async function saveTwoFactor() {
    try {
      await request("/api/profile/two-factor", "PUT", { method: twoFactorMethod, question, answer, caseSensitive, pin, password: authPassword });
      setUser((current) => ({ ...current, twoFactorType: twoFactorMethod === "none" ? "" : twoFactorMethod, securityQuestion: twoFactorMethod === "security_question" ? question : "" }));
      setDialog("");
      setError("");
      setAuthPassword("");
      notify("İki aşamalı doğrulama ayarın güncellendi.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ayar kaydedilemedi."); }
  }
  async function submitRecoveryEmail() {
    try {
      if (!emailPending) {
        const result = await request("/api/profile/recovery-email/request", "POST", { email: recoveryEmail, password: emailPassword });
        if (result.verified) { setUser((current) => ({ ...current, recoveryEmail: result.email })); setEmailPending(false); setDialog(""); notify("Kurtarma e-postası güncellendi."); }
        else { setEmailPending(true); notify(`Doğrulama kodu ${result.email} adresine gönderildi.`); }
      } else {
        const result = await request("/api/profile/recovery-email/confirm", "POST", { code: emailCode });
        setUser((current) => ({ ...current, recoveryEmail: result.recoveryEmail })); setEmailPending(false); setDialog(""); notify("Kurtarma e-postası doğrulandı.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "E-posta kaydedilemedi."); }
  }
  async function enableLock() {
    try {
      const result = await request("/api/profile/lock/enable", "POST", { code: lockCode, password: lockPassword });
      setUser((current) => ({ ...current, chatLocked: true }));
      setDialog("");
      setError("");
      notify(`Sohbet kilidi etkin. Kurtarma adresi: ${result.recoveryEmail}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sohbet kilidi etkinleştirilemedi."); }
  }
  async function recoverLock() {
    try {
      if (!lockRecoveryPending) {
        const result = await request("/api/profile/lock/recovery/request", "POST", {});
        setLockRecoveryPending(true);
        notify(`Doğrulama kodu ${result.email} adresine gönderildi.`);
      } else {
        await request("/api/profile/lock/recovery/confirm", "POST", { code: lockRecoveryCode });
        setUser((current) => ({ ...current, chatLocked: false }));
        setLockRecoveryPending(false);
        setLockRecoveryCode("");
        setDialog("");
        notify("Sohbet kilidi kurtarıldı ve kilitli sohbetler açıldı.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sohbet kilidi kurtarılamadı."); }
  }
  async function changePassword() {
    if (passwordNew !== passwordConfirm) { setError("Yeni şifreler eşleşmiyor."); return; }
    try {
      await request("/api/profile/password", "POST", { currentPassword: passwordOld, newPassword: passwordNew });
      setDialog("");
      setError("");
      setPasswordOld("");
      setPasswordNew("");
      setPasswordConfirm("");
      localStorage.removeItem("zibzib-token");
      localStorage.removeItem("zibzib-user");
      notify("Şifren güncellendi. Güvenlik için yeniden giriş yap.");
      window.setTimeout(() => window.location.assign("/giris"), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Şifre değiştirilemedi."); }
  }
  const tabs = [{ id: "profil", label: "Profil", icon: UserRound }, { id: "gizlilik", label: "Gizlilik", icon: LockKeyhole }, { id: "sohbet", label: "Sohbetler", icon: MessageCircle }, { id: "guvenlik", label: "Güvenlik", icon: Shield }, { id: "bildirimler", label: "Bildirimler", icon: Bell }];
  const title = tabs.find((item) => item.id === activeTab)?.label || "Profil";
  return <main className="settings-main">
    <header className="settings-top"><div><p className="eyebrow">TERCİHLERİN</p><h1>Ayarlar</h1></div><button className="icon-btn" aria-label="Yardım" onClick={() => notify("Yardım merkezi yakında.")}><CircleHelp /></button></header>
    <div className="settings-layout">
      <nav className="settings-tabs">{tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setActiveTab(id)} className={activeTab === id ? "active" : ""}><Icon size={17} />{label}<ChevronRight size={15} /></button>)}</nav>
      <section className="settings-content">
        <div className="settings-section-head"><div><p className="eyebrow">HESAP AYARLARI</p><h2>{title}</h2></div><span className="saved-badge"><span /> Kaydedildi</span></div>
        {activeTab === "profil" && <>
          <div className="profile-settings-card"><Avatar contact={{ id: "me", name: user.displayName, handle: user.username, initials: user.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("tr"), color: "mint", text: "", time: "", avatarUrl: user.avatarUrl || defaultAvatarUrl }} /><div><h3>{user.displayName || "Profil"}</h3><p>@{user.username}</p><label className="outline-button profile-file-button"><ImagePlus size={14} /> Fotoğrafı değiştir<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "Fotoğraf yüklenemedi.")); }} /></label></div></div>
          <SettingRow title="Görünen isim" description="Sohbetlerinde görünecek isim." action={<input className="setting-input" maxLength={40} value={profileName} onChange={(event) => setProfileName(event.target.value)} />} />
          <SettingRow title="Kullanıcı adı" description="3–24 karakter, küçük harf ve rakam." action={<input className="setting-input" maxLength={24} value={profileUsername} onChange={(event) => setProfileUsername(event.target.value.replace(/^@/, ""))} />} />
          <SettingRow title="Uygulama teması" description="ZibZib'ın görünümünü seç." action={<div className="segmented"><button className={theme === "light" ? "selected" : ""} onClick={() => { setTheme("light"); void updatePref("app_theme", "light"); }}><Sun size={15} /> Açık</button><button className={theme === "dark" ? "selected" : ""} onClick={() => { setTheme("dark"); void updatePref("app_theme", "dark"); }}><Moon size={15} /> Koyu</button></div>} />
          <div className="settings-actions"><span>İsim ve kullanıcı adındaki değişiklikleri kaydet.</span><button className="primary-button" onClick={() => void saveProfile()}>Profili kaydet</button></div>
        </>}
        {activeTab === "gizlilik" && <>
          <div className="settings-callout"><LockKeyhole size={18} /><span><strong>Gizliliğin senin elinde</strong><small>Bilgilerini kimlerin görebileceğini belirle.</small></span></div>
          <SettingRow title="Sohbet kilidi" description="Kilitli sohbetleri arama alanına kodunu girerek aç." action={<button className="outline-button" onClick={() => { setError(""); setLockRecoveryPending(false); setDialog("lock"); }}>{user.chatLocked ? "Kodu değiştir" : "Etkinleştir"} <ChevronRight size={15} /></button>} />
          <SettingRow title="Son görülme" description="Son aktif olduğun zamanı gizle; başkalarının bilgisini görmeye devam et." action={<Toggle label="Son görülme" enabled={prefs.last_seen_visible} onChange={(value) => void updatePref("last_seen_visible", value)} />} />
          <SettingRow title="Çevrimiçi bilgisi" description="Çevrimiçi olduğunu gizle; başkalarının bilgisini görmeye devam et." action={<Toggle label="Çevrimiçi bilgisi" enabled={prefs.online_visible} onChange={(value) => void updatePref("online_visible", value)} />} />
          <SettingRow title="Okundu bilgisi" description="Kapalıyken okundu bilgisini göndermez ve başkalarınınkini alamazsın." action={<Toggle label="Okundu bilgisi" enabled={prefs.read_receipts} onChange={(value) => void updatePref("read_receipts", value)} />} />
        </>}
        {activeTab === "sohbet" && <>
          <SettingRow title="Sohbet teması" description="Sohbet görünümünü uygulama temasından bağımsız seç." action={<div className="segmented"><button className={prefs.chat_theme === "light" ? "selected" : ""} onClick={() => void updatePref("chat_theme", "light")}><Sun size={14} /> Açık</button><button className={prefs.chat_theme === "dark" ? "selected" : ""} onClick={() => void updatePref("chat_theme", "dark")}><Moon size={14} /> Koyu</button></div>} />
          <SettingRow title="Fotoğrafları doğrudan göster" description="Kapalıysa görseli açmak için dokunman gerekir." action={<Toggle label="Fotoğraflar" enabled={prefs.show_photos_directly} onChange={(value) => void updatePref("show_photos_directly", value)} />} />
        </>}
        {activeTab === "guvenlik" && <>
          <div className="settings-callout"><Shield size={18} /><span><strong>Hesap güvenliği</strong><small>Güvenlik bilgilerini güncel tut.</small></span></div>
          <SettingRow title="Kurtarma e-postası" description={user.recoveryEmail || user.email || "Hesap kurtarma ve kilit e-postası."} action={<button className="outline-button" onClick={() => { setError(""); setEmailPending(false); setEmailPassword(""); setDialog("email"); }}>E-postayı düzenle <ChevronRight size={15} /></button>} />
          <SettingRow title="İki aşamalı doğrulama" description={user.twoFactorType ? `Etkin: ${user.twoFactorType === "email" ? "e-posta kodu" : user.twoFactorType === "pin" ? "PIN" : user.securityQuestion}` : "Girişte ek bir doğrulama adımı kullan."} action={<button className="outline-button" onClick={() => { setError(""); setTwoFactorMethod(user.twoFactorType || "none"); setQuestion(user.securityQuestion || "En sevdiğin isim"); setAuthPassword(""); setDialog("two-factor"); }}>Ayarla <ChevronRight size={15} /></button>} />
          <SettingRow title="Şifre değiştir" description="Eski şifreni doğrulayarak yeni bir şifre belirle." action={<button className="outline-button" onClick={() => { setError(""); setDialog("password"); }}>Şifreyi değiştir <ChevronRight size={15} /></button>} />
        </>}
        {activeTab === "bildirimler" && <>
          <div className="settings-callout"><Bell size={18} /><span><strong>Bildirim izinleri</strong><small>Tarayıcı bildirimi için tarayıcı ayarlarında izin ver.</small></span></div>
          <SettingRow title="Masaüstü bildirimleri" description="Uygulama açık değilken yeni mesajlardan haberdar ol." action={<button className="outline-button" onClick={async () => { if (!("Notification" in window)) { notify("Bu tarayıcı bildirimleri desteklemiyor."); return; } const permission = await Notification.requestPermission(); notify(permission === "granted" ? "Masaüstü bildirimleri açıldı." : "Bildirim izni verilmedi."); }}>İzni ayarla <ChevronRight size={15} /></button>} />
        </>}
      </section>
    </div>
    <footer className="settings-footer">ZibZib · Sürüm 1.0 <span>Yardım merkezi&nbsp;&nbsp; Gizlilik</span></footer>
    {dialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setDialog(""); setError(""); } }}><section className="modal-card settings-dialog">
      <div className="modal-title"><div><p className="eyebrow">GÜVENLİK AYARLARI</p><h2>{dialog === "lock" ? "Sohbet kilidi" : dialog === "email" ? "Kurtarma e-postası" : dialog === "password" ? "Şifre değiştir" : "İki aşamalı doğrulama"}</h2></div><button className="icon-btn" onClick={() => { setDialog(""); setError(""); }} aria-label="Kapat"><X /></button></div>
      {dialog === "lock" && <><p className="modal-desc">Kilitli sohbetler listeden saklanır. Arama alanına kilit kodunu girerek bu oturumda görünür yapabilirsin.</p>{!lockRecoveryPending ? <><label>Kilit kodu<input type="password" autoComplete="new-password" value={lockCode} onChange={(event) => setLockCode(event.target.value)} placeholder="En az 4 karakter" minLength={4} maxLength={32} /></label><label>Hesap şifren<input type="password" value={lockPassword} onChange={(event) => setLockPassword(event.target.value)} /></label></> : <label>E-postana gönderilen 6 haneli kod<input inputMode="numeric" maxLength={6} value={lockRecoveryCode} onChange={(event) => setLockRecoveryCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>}{error && <p className="modal-error" role="alert">{error}</p>}{lockRecoveryPending ? <button className="primary-button full-button" onClick={() => void recoverLock()}>Kilidi sıfırla</button> : <><button className="primary-button full-button" onClick={() => void enableLock()}>Kilit kodunu kaydet</button>{user.chatLocked && <button className="text-button" onClick={() => void recoverLock()}>Kilit kodunu unuttum</button>}</>}</>}
      {dialog === "email" && <><p className="modal-desc">Bu adres sohbet kilidi ve hesap kurtarmada kullanılır. Doğrulama tamamlanınca her iki yerde güncellenir.</p>{!emailPending ? <><label>Kurtarma e-postası<input type="email" autoComplete="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} /></label><label>Hesap şifren<input type="password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} /></label></> : <label>E-posta doğrulama kodu<input inputMode="numeric" maxLength={6} value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="6 haneli kod" /></label>}{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void submitRecoveryEmail()}>{emailPending ? "E-postayı doğrula" : "Doğrulama kodu gönder"}</button></>}
      {dialog === "two-factor" && <><p className="modal-desc">Şifrenle giriş yaptıktan sonra bu yöntemle hesabını doğrula.</p><label>Doğrulama yöntemi<select value={twoFactorMethod} onChange={(event) => setTwoFactorMethod(event.target.value)}><option value="none">Kapalı</option><option value="email">E-posta kodu</option><option value="security_question">Güvenlik sorusu</option><option value="pin">6 haneli PIN</option></select></label>{twoFactorMethod === "security_question" && <><label>Güvenlik sorusu<select value={question} onChange={(event) => setQuestion(event.target.value)}><option>En sevdiğin isim</option><option>En sevdiğin hayvan</option><option>En sevdiğin arkadaş</option></select></label><label>Yanıt<input value={answer} onChange={(event) => setAnswer(event.target.value)} /></label><label className="check-label"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Büyük/küçük harfe duyarlı olsun</label></>}{twoFactorMethod === "pin" && <label>6 haneli PIN<input inputMode="numeric" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>}<label>Hesap şifren<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void saveTwoFactor()}>Güvenlik ayarını kaydet</button></>}
      {dialog === "password" && <><p className="modal-desc">Şifre değiştiğinde diğer cihazlardaki oturumların kapatılır.</p><label>Eski şifren<input type="password" autoComplete="current-password" value={passwordOld} onChange={(event) => setPasswordOld(event.target.value)} /></label><label>Yeni şifre<input type="password" autoComplete="new-password" minLength={8} value={passwordNew} onChange={(event) => setPasswordNew(event.target.value)} /></label><label>Yeni şifreyi tekrar gir<input type="password" autoComplete="new-password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} /></label>{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void changePassword()}>Şifreyi güncelle</button></>}
    </section></div>}
  </main>;
}

function SettingRow({ title, description, action }: { title: string; description: string; action: React.ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div><div className="setting-action">{action}</div></div>;
}

function Toggle({ label, enabled, onChange }: { label: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <button role="switch" aria-checked={enabled} aria-label={label} className={`toggle ${enabled ? "on" : ""}`} onClick={() => onChange(!enabled)}><span /></button>;
}

function AdminPage({ notify }: { notify: (message: string) => void }) {
  const [active, setActive] = useState("Genel bakış");
  const [summary, setSummary] = useState({ users: "—", messages_today: "—", online_now: "—", pending_requests: "—" });
  const [settings, setSettings] = useState<Record<string, string>>({ light_background: "#e2ddbb", dark_background: "#000000" });
  const [users, setUsers] = useState<{ id: string; username: string; display_name: string; email: string; is_disabled: boolean; is_admin: boolean }[]>([]);
  const [query, setQuery] = useState("");
  const [adminError, setAdminError] = useState("");
  const token = localStorage.getItem("zibzib-token") || "";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function loadUsers() {
    const response = await fetch(`/api/admin/users?q=${encodeURIComponent(query)}`, { headers });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Kullanıcılar yüklenemedi.");
    setUsers(data.users);
  }
  async function uploadSetting(key: string, file?: File) {
    if (!file) return;
    const body = new FormData(); body.append("key", key); body.append("image", file);
    const response = await fetch("/api/admin/uploads", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Görsel yüklenemedi.");
    setSettings((current) => ({ ...current, [key]: data.value }));
    notify("Yönetim görünümü güncellendi.");
  }
  useEffect(() => {
    Promise.all([
      fetch("/api/admin/summary", { headers }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Yönetim verileri yüklenemedi."); setSummary(data.summary); }),
      fetch("/api/admin/settings", { headers }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Yönetim ayarları yüklenemedi."); const stored = data.settings as Record<string, { value: string }>; setSettings((current) => ({ ...current, ...Object.fromEntries(Object.entries(stored).map(([key, item]) => [key, item.value])) })); })
    ]).catch((error: unknown) => setAdminError(error instanceof Error ? error.message : "Yönetim verileri yüklenemedi."));
  }, []);
  useEffect(() => {
    if (active !== "Kullanıcılar") return;
    void loadUsers().catch((error: unknown) => setAdminError(error instanceof Error ? error.message : "Kullanıcılar yüklenemedi."));
  }, [active]);
  async function saveColors() {
    try {
      for (const key of ["light_background", "dark_background"]) {
        const response = await fetch(`/api/admin/settings/${key}`, { method: "PATCH", headers, body: JSON.stringify({ value: settings[key] }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "Tema kaydedilemedi.");
      }
      document.documentElement.style.setProperty("--admin-light-bg", settings.light_background);
      document.documentElement.style.setProperty("--admin-dark-bg", settings.dark_background);
      notify("Tema renkleri kaydedildi.");
    } catch (error) { notify(error instanceof Error ? error.message : "Tema kaydedilemedi."); }
  }
  async function setUserDisabled(userId: string, disabled: boolean) {
    try {
      const response = await fetch(`/api/admin/users/${userId}/status`, { method: "PATCH", headers, body: JSON.stringify({ disabled }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Hesap durumu güncellenemedi.");
      setUsers((current) => current.map((user) => user.id === userId ? { ...user, is_disabled: disabled } : user));
    } catch (error) { setAdminError(error instanceof Error ? error.message : "Hesap durumu güncellenemedi."); }
  }
  const links = ["Genel bakış", "Kullanıcılar", "İçerik ve görünüm", "Sistem ayarları"];
  return <main className="admin-main">
    <header className="admin-header"><div className="admin-brand"><Brand /><span className="admin-tag">YÖNETİM</span></div><div className="admin-header-right"><span className="admin-status"><i /> Sistem çalışıyor</span><div className="admin-user">Yönetici <span>Y</span></div></div></header>
    <div className="admin-content"><aside className="admin-nav"><p className="side-label">YÖNETİM</p>{links.map((link, index) => <button key={link} className={active === link ? "active" : ""} onClick={() => setActive(link)}>{[SlidersHorizontal, Users, ImagePlus, Settings].map((Icon, i) => i === index ? <Icon key={i} size={17} /> : null)}{link}<ChevronRight size={14} /></button>)}<div className="admin-nav-bottom"><span className="secure-dot" /> Yönetici oturumu açık</div></aside>
      <section className="admin-dashboard"><div className="admin-title-row"><div><p className="eyebrow">ZIBZIB YÖNETİM MERKEZİ</p><h1>{active}</h1><p>Uygulamanın durumunu ve tercihlerini buradan yönet.</p></div><button className="outline-button"><Clock3 size={15} /> Son 30 gün <ChevronDown size={14} /></button></div>
        {adminError && <p className="modal-error" role="alert">{adminError}</p>}
        <div className="admin-stats"><Stat label="Toplam kullanıcı" value={String(summary.users)} trend="Kayıtlı hesaplar" /><Stat label="Günlük mesajlar" value={String(summary.messages_today)} trend="Son 24 saat" /><Stat label="Çevrimiçi şimdi" value={String(summary.online_now)} trend="Son 5 dakika" /><Stat label="Bekleyen istekler" value={String(summary.pending_requests)} trend="İncelenmeyi bekliyor" /></div>
        {active === "Kullanıcılar" ? <div className="admin-card admin-user-list"><div className="card-heading"><div><h2>Kullanıcı hesapları</h2><p>Hesapları ara ve erişim durumlarını yönet.</p></div><Users size={18} /></div><form className="admin-search" onSubmit={(event) => { event.preventDefault(); void loadUsers().catch((error: unknown) => setAdminError(error instanceof Error ? error.message : "Kullanıcılar yüklenemedi.")); }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="İsim, kullanıcı adı veya e-posta" /><button className="outline-button">Ara</button></form>{users.map((user) => <div className="admin-user-row" key={user.id}><span><strong>{user.display_name}</strong><small>@{user.username} · {user.email}</small></span><b>{user.is_admin ? "Yönetici" : user.is_disabled ? "Devre dışı" : "Etkin"}</b>{!user.is_admin && <button className="outline-button" onClick={() => void setUserDisabled(user.id, !user.is_disabled)}>{user.is_disabled ? "Etkinleştir" : "Devre dışı bırak"}</button>}</div>)}</div> :
        <div className="admin-columns"><div className="admin-card"><div className="card-heading"><div><h2>Görünüm ve marka</h2><p>ZibZib'ın kullanıcı arayüzünü düzenle.</p></div><SlidersHorizontal size={18} /></div><div className="admin-setting"><div><strong>Profil fotoğrafı varsayılanı</strong><small>Fotoğrafı olmayan hesaplarda gösterilir.</small></div><label className="outline-button">Görsel seç <ImagePlus size={15} /><input className="admin-file-input" type="file" accept="image/*" onChange={(event) => void uploadSetting("default_avatar_url", event.target.files?.[0]).catch((error: unknown) => notify(error instanceof Error ? error.message : "Görsel yüklenemedi."))} /></label></div><div className="admin-setting"><div><strong>Açık tema arka planı</strong><small>Varsayılan: #E2DDBB</small></div><input className="color-input" type="color" value={settings.light_background || "#e2ddbb"} onChange={(event) => setSettings((current) => ({ ...current, light_background: event.target.value }))} /></div><div className="admin-setting"><div><strong>Koyu tema arka planı</strong><small>Varsayılan: #000000</small></div><input className="color-input" type="color" value={settings.dark_background || "#000000"} onChange={(event) => setSettings((current) => ({ ...current, dark_background: event.target.value }))} /></div><div className="admin-setting"><div><strong>Açık sohbet arka planı</strong><small>Sohbetlerde kullanılan desen.</small></div><label className="outline-button">Görsel yükle <ImagePlus size={15} /><input className="admin-file-input" type="file" accept="image/*" onChange={(event) => void uploadSetting("light_chat_background", event.target.files?.[0]).catch((error: unknown) => notify(error instanceof Error ? error.message : "Görsel yüklenemedi."))} /></label></div><div className="admin-setting"><div><strong>Koyu sohbet arka planı</strong><small>Koyu temada kullanılan desen.</small></div><label className="outline-button">Görsel yükle <ImagePlus size={15} /><input className="admin-file-input" type="file" accept="image/*" onChange={(event) => void uploadSetting("dark_chat_background", event.target.files?.[0]).catch((error: unknown) => notify(error instanceof Error ? error.message : "Görsel yüklenemedi."))} /></label></div><button className="primary-button save-admin" onClick={() => void saveColors()}>Görünümü kaydet</button></div>
          <div className="admin-card status-card"><div className="card-heading"><div><h2>Sistem durumu</h2><p>Servislerin anlık durumu.</p></div><span className="live-badge"><i /> CANLI</span></div><div className="service-row"><span><span className="service-dot" /> Web uygulaması</span><b>Çalışıyor</b></div><div className="service-row"><span><span className="service-dot" /> Mesaj servisi</span><b>Çalışıyor</b></div><div className="service-row"><span><span className="service-dot muted" /> E-posta servisi</span><b>Yapılandırılmadı</b></div><div className="admin-notice"><Shield size={17} /><p><strong>Yönetici hesabı</strong><br />Güvenlik için yönetici parolasını ortam değişkenlerinde belirleyin. Parolalar kaynak koduna eklenmez.</p></div></div>
        </div>}
      </section>
    </div>
  </main>;
}

function Stat({ label, value, trend }: { label: string; value: string; trend: string }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small><ArrowDownLeft size={13} /> {trend}</small></div>;
}

function Modal({ title, close, notify, onChange, contacts, navigate, selectedContact, defaultAvatarUrl }: { title: string; close: () => void; notify: (text: string) => void; onChange: () => void; contacts: Contact[]; navigate: (path: string) => void; selectedContact?: Contact; defaultAvatarUrl: string }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<{ id: string; username: string; display_name: string; avatar_url?: string | null }[]>([]);
  const [calls, setCalls] = useState<{ id: string; status: string; started_at: string; conversation_id: string; peer_name: string; peer_username: string }[]>([]);
  const [archives, setArchives] = useState<{ id: string; title: string | null; kind: string; peer_name: string | null; peer_username: string | null; last_message: string | null }[]>([]);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [allowedSenders, setAllowedSenders] = useState<string[]>([]);
  const [groupPhoto, setGroupPhoto] = useState<File | null>(null);
  const [groupPhotoPreview, setGroupPhotoPreview] = useState("");
  const [messagePolicy, setMessagePolicy] = useState("all");
  const [photoPolicy, setPhotoPolicy] = useState("all");
  const [broadcastRecipients, setBroadcastRecipients] = useState<string[]>([]);
  const [broadcastText, setBroadcastText] = useState("");
  const [broadcastPhoto, setBroadcastPhoto] = useState<File | null>(null);
  const [lockCode, setLockCode] = useState("");
  const isFriend = title === "Kullanıcı ara" || title === "Yeni sohbet";
  const isGroup = title === "Grup oluştur";
  const isBulk = title === "Toplu mesaj";
  useEffect(() => {
    if (title !== "Aramalar") return;
    let active = true;
    void fetch("/api/calls", { headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Arama geçmişi yüklenemedi."); if (active) setCalls(data.calls); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Arama geçmişi yüklenemedi."); });
    return () => { active = false; };
  }, [title]);
  useEffect(() => {
    if (title !== "Arşivlenmiş sohbetler") return;
    let active = true;
    void fetch("/api/conversations?archived=true", { headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Arşiv yüklenemedi."); if (active) setArchives(data.conversations); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Arşiv yüklenemedi."); });
    return () => { active = false; };
  }, [title]);
  async function restoreArchivedChat(conversationId: string) {
    try {
      const response = await fetch(`/api/conversations/${conversationId}/preferences`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ archived: false }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Sohbet arşivden çıkarılamadı.");
      setArchives((current) => current.filter((conversation) => conversation.id !== conversationId));
      onChange();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sohbet arşivden çıkarılamadı."); }
  }
  const friends = contacts.filter((contact) => contact.userId && !contact.request && contact.handle.startsWith("@") && !contact.handle.includes("(siz)"));
  async function findUsers() {
    if (query.trim().length < 2) { setError("En az 2 karakter girin."); return; }
    setSearching(true);
    setError("");
    try {
      const response = await fetch(`/api/users/search?q=${encodeURIComponent(query.trim())}`, { headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Kullanıcı aranamadı.");
      setUsers(data.users);
      if (!data.users.length) setError("Eşleşen kullanıcı bulunamadı.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sunucuya bağlanılamadı."); }
    finally { setSearching(false); }
  }
  async function sendRequest(username: string) {
    try {
      const response = await fetch("/api/friend-requests", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ username }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "İstek gönderilemedi.");
      notify(`@${username} için arkadaşlık isteği gönderildi.`);
      onChange();
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "İstek gönderilemedi."); }
  }
  async function createSelfChat() {
    try {
      const response = await fetch("/api/conversations/self", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Kişisel sohbet açılamadı.");
      onChange();
      close();
      navigate(`/sohbet/${data.conversationId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Kişisel sohbet açılamadı."); }
  }
  async function createGroup() {
    if (groupMembers.length === 0) { setError("Gruba eklemek için en az bir arkadaş seçin."); return; }
    if (messagePolicy === "selected" && allowedSenders.length === 0) { setError("Mesaj gönderebilecek en az bir üyeyi seçin."); return; }
    try {
      const response = await fetch("/api/conversations/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` },
        body: JSON.stringify({ title: groupName, memberIds: groupMembers, messagePolicy, photoPolicy, allowedUserIds: messagePolicy === "selected" ? allowedSenders : undefined })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Grup oluşturulamadı.");
      if (groupPhoto) {
        const body = new FormData(); body.append("image", groupPhoto);
        const photoResponse = await fetch(`/api/conversations/${data.conversationId}/avatar`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body });
        const photoData = await photoResponse.json();
        if (!photoResponse.ok) notify(photoData.error || "Grup oluşturuldu ancak fotoğrafı yüklenemedi.");
      }
      onChange();
      close();
      navigate(`/sohbet/${data.conversationId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Grup oluşturulamadı."); }
  }
  async function sendBroadcast() {
    if (!broadcastRecipients.length) { setError("En az bir arkadaş seçin."); return; }
    const body = new FormData();
    body.append("userIds", JSON.stringify(broadcastRecipients));
    body.append("message", broadcastText);
    if (broadcastPhoto) body.append("image", broadcastPhoto);
    try {
      const response = await fetch("/api/broadcasts", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Toplu mesaj gönderilemedi.");
      notify(`${data.sent} kişiye mesaj gönderildi.`);
      onChange();
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Toplu mesaj gönderilemedi."); }
  }
  async function updateConversationPreference(data: { muted?: boolean; archived?: boolean }) {
    if (!selectedContact) return;
    try {
      const response = await fetch(`/api/conversations/${selectedContact.id}/preferences`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sohbet tercihi kaydedilemedi.");
      onChange(); close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sohbet tercihi kaydedilemedi."); }
  }
  async function updateConversationLock(locked: boolean) {
    if (!selectedContact) return;
    try {
      const response = await fetch(`/api/conversations/${selectedContact.id}/lock`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zibzib-token")}` }, body: JSON.stringify({ locked, code: lockCode }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sohbet kilidi güncellenemedi.");
      onChange(); close();
      notify(locked ? "Sohbet kilitlendi." : "Sohbet kilidi kaldırıldı.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sohbet kilidi güncellenemedi."); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="modal-card">
    <div className="modal-title"><div><p className="eyebrow">YENİ BİR BAŞLANGIÇ</p><h2>{title}</h2></div><button className="icon-btn" onClick={close} aria-label="Kapat"><X /></button></div>
    {isFriend ? <><p className="modal-desc">Kullanıcı adı veya kişi ismiyle ZibZib'da ara.</p><label className="searchbox modal-search"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void findUsers(); } }} placeholder="@kullaniciadi veya isim" /></label>{error && <p className="modal-error" role="alert">{error}</p>}{users.length > 0 ? <div className="user-results">{users.map((user) => <div className="user-result" key={user.id}><div className="avatar mint">{user.avatar_url || defaultAvatarUrl ? <img src={user.avatar_url || defaultAvatarUrl} alt="" /> : user.display_name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("tr")}</div><span><strong>{user.display_name}</strong><small>@{user.username}</small></span><button className="outline-button" onClick={() => void sendRequest(user.username)}>İstek gönder</button></div>)}</div> : <div className="modal-empty"><UserRound size={23} /><span>Aramak için bir kullanıcı adı gir.</span></div>}{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" disabled={searching} onClick={() => void findUsers()}>{searching ? "Aranıyor..." : "Kullanıcıyı ara"} <ArrowRight size={16} /></button></> :
      isGroup ? <><p className="modal-desc">Grup adını belirle, arkadaşlarını seç ve gönderim izinlerini ayarla.</p><label>Grup adı<input maxLength={60} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Örn. Hafta sonu planı" /></label><label className="outline-button group-photo-label">{groupPhotoPreview ? <img src={groupPhotoPreview} alt="" /> : <ImagePlus size={15} />} Grup fotoğrafı seç<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setGroupPhoto(file); setGroupPhotoPreview(URL.createObjectURL(file)); } }} /></label><div className="group-members"><strong>Üyeler</strong>{friends.length ? friends.map((friend) => <label key={friend.id}><input type="checkbox" checked={groupMembers.includes(friend.userId!)} onChange={(event) => { setGroupMembers((current) => event.target.checked ? [...current, friend.userId!] : current.filter((id) => id !== friend.userId)); if (!event.target.checked) setAllowedSenders((current) => current.filter((id) => id !== friend.userId)); }} /><span>{friend.name}<small>{friend.handle}</small></span></label>) : <p>Önce arkadaş ekleyerek grup oluşturabilirsin.</p>}</div><label>Mesaj gönderme izni<select value={messagePolicy} onChange={(event) => setMessagePolicy(event.target.value)}><option value="all">Herkes mesaj gönderebilir</option><option value="admins">Sadece yöneticiler</option><option value="selected">Belirli üyeler</option></select></label>{messagePolicy === "selected" && <div className="group-members"><strong>Mesaj gönderebilecek üyeler</strong>{friends.filter((friend) => groupMembers.includes(friend.userId || "")).map((friend) => <label key={friend.id}><input type="checkbox" checked={allowedSenders.includes(friend.userId!)} onChange={(event) => setAllowedSenders((current) => event.target.checked ? [...current, friend.userId!] : current.filter((id) => id !== friend.userId))} /><span>{friend.name}</span></label>)}</div>}<label>Fotoğraf gönderme izni<select value={photoPolicy} onChange={(event) => setPhotoPolicy(event.target.value)}><option value="all">Herkes fotoğraf gönderebilir</option><option value="admins">Sadece yöneticiler</option><option value="none">Fotoğraf gönderilemez</option></select></label>{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void createGroup()}>Grubu oluştur <ArrowRight size={16} /></button></> :
      title === "Aramalar" ? <><p className="modal-desc">Son aramaların.</p>{calls.map((call) => <button className="call-history-row" key={call.id} onClick={() => { close(); navigate(`/sohbet/${call.conversation_id}`); }}><span><strong>{call.peer_name}</strong><small>@{call.peer_username} · {new Date(call.started_at).toLocaleString("tr-TR")}</small></span><b>{call.status === "ended" ? "Tamamlandı" : call.status === "missed" ? "Cevapsız" : call.status === "rejected" ? "Reddedildi" : call.status === "ringing" ? "Çalıyor" : "Arama"}</b></button>)}{!calls.length && !error && <div className="modal-empty"><Phone size={24} /><span>Henüz arama kaydı yok.</span></div>}{error && <p className="modal-error" role="alert">{error}</p>}</> :
      title === "Arşivlenmiş sohbetler" ? <><p className="modal-desc">Arşivden çıkarmak veya tekrar açmak istediğin sohbeti seç.</p>{archives.map((conversation) => <div className="call-history-row" key={conversation.id}><button onClick={() => { close(); navigate(`/sohbet/${conversation.id}`); }}><strong>{conversation.title || conversation.peer_name || "Sohbet"}</strong><small>{conversation.last_message || "Henüz mesaj yok"}</small></button><button className="outline-button" onClick={() => void restoreArchivedChat(conversation.id)}>Arşivden çıkar</button></div>)}{!archives.length && !error && <div className="modal-empty"><MessageCircle size={24} /><span>Arşivlenmiş sohbet yok.</span></div>}{error && <p className="modal-error" role="alert">{error}</p>}</> :
      title === "Kendinize mesaj gönderin" ? <><p className="modal-desc">Kendinize notlar ve hatırlatmalar gönderebileceğiniz özel bir sohbet oluşturun.</p>{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void createSelfChat()}>Kişisel sohbeti aç <ArrowRight size={16} /></button></> :
      isBulk ? <><p className="modal-desc">Aynı mesajı seçtiğin arkadaşlarına ayrı sohbetler olarak gönder.</p><div className="group-members">{friends.map((friend) => <label key={friend.id}><input type="checkbox" checked={broadcastRecipients.includes(friend.userId!)} onChange={(event) => setBroadcastRecipients((current) => event.target.checked ? [...current, friend.userId!] : current.filter((id) => id !== friend.userId))} /><span>{friend.name}<small>{friend.handle}</small></span></label>)}</div><label>Mesaj<textarea value={broadcastText} onChange={(event) => setBroadcastText(event.target.value)} maxLength={4000} rows={4} placeholder="Göndermek istediğin mesaj..." /></label><label className="outline-button">Fotoğraf ekle <ImagePlus size={15} /><input className="admin-file-input" type="file" accept="image/*" onChange={(event) => setBroadcastPhoto(event.target.files?.[0] || null)} /></label>{error && <p className="modal-error" role="alert">{error}</p>}<button className="primary-button full-button" onClick={() => void sendBroadcast()}>Seçilenlere gönder <Send size={15} /></button></> :
      title === "Sohbet seçenekleri" && selectedContact ? <><p className="modal-desc">{selectedContact.name} sohbetinin görünüm ve gizlilik tercihleri.</p><button className="outline-button full-button" onClick={() => void updateConversationPreference({ muted: !selectedContact.muted })}>{selectedContact.muted ? "Sessizi kaldır" : "Sessize al"}</button><button className="outline-button full-button" onClick={() => void updateConversationPreference({ archived: !selectedContact.archived })}>{selectedContact.archived ? "Arşivden çıkar" : "Sohbeti arşivle"}</button><label>Kilit kodu<input type="password" value={lockCode} onChange={(event) => setLockCode(event.target.value)} placeholder="Sohbet kilidi kodu" /></label><button className="outline-button full-button" onClick={() => void updateConversationLock(!selectedContact.locked)}>{selectedContact.locked ? "Kilidi kaldır" : "Sohbeti kilitle"}</button>{error && <p className="modal-error" role="alert">{error}</p>}</> :
      <><p className="modal-desc">Bu işlem için bir seçenek belirleyin.</p><button className="primary-button full-button" onClick={close}>Kapat</button></>}
  </div></div>;
}

export default App;
