# ZibZib

Türkçe arayüzlü, mobil uyumlu bir mesajlaşma uygulaması. İstemci React/Vite, API Express, veriler PostgreSQL'de saklanır; canlı mesajlaşma ve arama sinyalleşmesi Socket.IO kullanır.

## Yerel geliştirme

1. Bu dizinde `npm install` çalıştırın.
2. `.env.example` dosyasını `.env` olarak kopyalayın. PostgreSQL veritabanı oluşturup `DATABASE_URL`, en az 32 karakterli rastgele `JWT_SECRET` ve `ADMIN_PASSWORD` değerlerini ayarlayın.
3. E-posta doğrulaması ve parola kurtarma için `RESEND_API_KEY` ve doğrulanmış gönderici `EMAIL_FROM` tanımlayın.
4. `npm run server` ve `npm run dev` komutlarını ayrı terminallerde çalıştırın; uygulama `http://localhost:5173` adresindedir. Sunucu başlangıcında `server/schema.sql` uygulanır.

Üretim için `npm run build` ve `npm start` kullanılır. Express derlenmiş Vite uygulamasını aynı origin üzerinden sunar.

## Railway dağıtımı

1. Railway'de GitHub deposu `byoshhii-netizen/zibzib` ve `main` branch'i üzerinden bir servis oluşturun. Root Directory proje kökü (`/`) olmalı. `railway.json` build (`npm run build`), start (`npm start`) ve `/api/health` sağlık kontrolünü ayarlar.
2. Aynı Railway ortamına bir PostgreSQL servisi ekleyin. Uygulama servisindeki `DATABASE_URL` değişkenini PostgreSQL servisinin `DATABASE_URL` değişkenine bağlayın (servis adı `Postgres` ise değer `${{Postgres.DATABASE_URL}}` olur).
3. Uygulama servisinde şu değişkenleri tanımlayın:
   - `JWT_SECRET`: en az 32 karakterli, rastgele ve gizli bir değer.
   - `ADMIN_USERNAME`: isteğe bağlı; varsayılan `anambabamveçayım`.
   - `ADMIN_PASSWORD`: en az 8 karakterli, güçlü yönetici parolası. Bu değişken her sunucu başlangıcında yönetici parolasını eşitler.
   - `NODE_ENV`: `production`.
   - `RESEND_API_KEY` ve `EMAIL_FROM`: e-posta doğrulama ve parola kurtarma için. Resend'de doğrulanmış gönderici adresini kullanın.
   - `CLIENT_ORIGIN`: Railway alan adı oluşturulduktan sonra sitenin tam origin'i, ör. `https://zibzib-production.up.railway.app` (sonunda `/` olmadan). Socket.IO ve CORS bu değeri kullanır.
4. Uygulama servisine `/data` konumuna bağlanan bir Railway Volume ekleyin ve `UPLOAD_DIR=/data/uploads` değişkenini tanımlayın. Profil ve sohbet görselleri kalıcı volume'da tutulur.
5. Alan adı oluşturup `CLIENT_ORIGIN` değerini bu alan adına göre güncelleyin ve deploy edin. Deploy sonrasında `https://<alan-adınız>/api/health` adresi `{"status":"ok"}` döndürmelidir.

`PORT` değişkenini elle tanımlamayın; Railway'in verdiği port kullanılır. Veritabanı tabloları sunucu başlangıcında `server/schema.sql` ile oluşturulur. E-posta değişkenleri ayarlanmadan kayıt, iki aşamalı e-posta doğrulaması ve parola kurtarma çalışmaz. Socket.IO çevrimiçi durumu süreç belleğinde tuttuğundan tek sunucu örneğiyle çalışır.

Birden fazla replika için paylaşımlı Socket.IO adapter/presence servisi gerekir. WebRTC aramalarında yerel/uygun ağlarda doğrudan bağlantı kurulabilir; üretim ağlarında bağlantı güvenilirliği için TURN sunucusu yapılandırılması gerekir.

## Özellikler

- Telefon, e-posta ve kullanıcı adıyla kayıt; benzersiz Türkçe karakterli kullanıcı adları ve profil fotoğrafı kırpma/yükleme
- Kullanıcı arama, arkadaşlık istekleri, bire bir ve kendine mesaj sohbetleri
- Canlı metin/fotoğraf mesajları; düzenleme, yanıtlama, silme ve okundu bilgisi
- Grup oluşturma, fotoğraf, mesaj ve üye gönderim izinleri; toplu mesaj gönderimi
- Sohbet sessize alma, arşivleme ve kilitleme; gizlilik, kurtarma e-postası ve parola ayarları
- E-posta, güvenlik sorusu veya PIN ile iki aşamalı giriş; e-posta ile parola sıfırlama
- Sesli/görüntülü arama ve temel yönetici paneli (tema, varsayılan profil görseli ve hesap erişimi)
- Açık/koyu tema ve telefon/masaüstü için duyarlı Türkçe arayüz

## İşletim notları

- Yönetici hesabı sunucu başlangıcında `ADMIN_USERNAME` (varsayılan `anambabamveçayım`) ve `ADMIN_PASSWORD` ile oluşturulur. Gerçek parolayı kaynak koda veya repoya koymayın.
- E-posta işlemleri Resend API'si ve doğrulanmış `EMAIL_FROM` gerektirir. Veritabanı ve e-posta sırları olmadan kayıt, doğrulama ve kurtarma akışları uçtan uca çalışmaz.
- `npm run build` tip kontrolü ve üretim istemci derlemesini yapar; `npm audit --omit=dev` üretim bağımlılıklarını denetler.
