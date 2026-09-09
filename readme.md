# AnythingVideoDownloader

Bir sayfanın adresini yapıştır, içindeki videoyu veya sesi bul, indir ve istediğin
biçimde kaydet. **Tüm ağır iş senin bilgisayarında yapılır** — indirme, HLS/DASH
segmentlerinin birleştirilmesi, şifre çözme ve format dönüşümü tarayıcının içinde
WebAssembly ile çalışır. Sunucuda video işlenmez.

**Canlı site:** https://anything-video-downloader.netlify.app

---

## Neden yeniden yazıldı?

Projenin ilk hâli Flask + `yt-dlp` + sistem FFmpeg'i kullanan bir sunucu
uygulamasıydı: video sunucuya iniyor, orada işleniyor, sonra kullanıcıya
gönderiliyordu. Netlify sunucusuz bir platform olduğu için bu mimari orada
çalışamaz — kalıcı disk yok, uzun süreli işlem yok, Python çalışma ortamı yok ve
fonksiyonlar saniyeler içinde sonlanır.

Bu sürüm işi tersine çevirir:

| | Eski (Flask) | Yeni (Netlify) |
|---|---|---|
| Video indirme | Sunucu | Tarayıcı |
| Birleştirme / dönüştürme | Sunucu FFmpeg'i | Tarayıcıda `ffmpeg.wasm` |
| Geçici dosyalar | Sunucu diski | Tarayıcı belleği |
| Ölçeklenme maliyeti | Kullanıcı sayısıyla artar | Sabit (iş kullanıcıda) |
| Gizlilik | Video sunucudan geçer | Video sunucuda hiç işlenmez |

---

## Nasıl çalışıyor?

```
 Tarayıcı                          Netlify                        Hedef site
 ─────────                         ───────                        ──────────
 1. adres  ───────────────────►  /api/resolve  ──── HTML oku ───►  sayfa
                                (yalnızca metin ayrıştırır)
    ◄──────── medya adayları ────────┘

 2. segment/parça istekleri ────►  /api/proxy   ──── byte aktar ──►  CDN
    ◄──────── ham baytlar ──────────┘   (CORS köprüsü, işlem yok)

 3. ffmpeg.wasm (Web Worker)
    AES-128 çözme · segment birleştirme · mux · MP3/WAV kodlama
    ▼
 4. dosya doğrudan diske kaydedilir
```

**1. Çözümleme (sunucu, milisaniyeler).** `/api/resolve` önce adresin bilinen bir
platforma ait olup olmadığına bakar ve varsa o platformun kendi oynatıcı ucunu kullanır
(YouTube, X, Instagram, Vimeo, Dailymotion, Reddit). Değilse sayfanın HTML'ini okur:
`og:video` / `twitter:player:stream` meta etiketleri, JSON-LD `contentUrl`, `<video>` ve
`<source>` etiketleri, `application/x-mpegURL` bağlantıları ve son çare olarak tüm
belgede (JSON kaçış dizileri çözülmüş hâlde) medya uzantısı taraması. Hâlâ bulunamazsa
gömülü oynatıcıları (`<iframe>`) bir seviye takip eder. Video baytlarına hiç dokunmaz.

**2. İndirme (senin bilgisayarın).** Tarayıcı önce tek baytlık bir `Range` isteğiyle
dosya boyutunu ve aralık desteğini ölçer, sonra dosyayı 4 MB'lik parçalar hâlinde 4
paralel istekle çeker; HLS/DASH ise segmentleri 6 paralel istekle indirir.
`#EXT-X-KEY` ile şifrelenmiş HLS akışları WebCrypto (AES-CBC) ile tarayıcıda çözülür.
Geçici hatalar (`429`, `503` …) üstel geri çekilmeyle 4 kez yeniden denenir; sunucu
eşzamanlı isteklere ısrarla direnirse indirme tek bağlantıya düşer. Parçalı indirme
aynı zamanda her sunucu isteğini kısa tutar, böylece Netlify fonksiyon süre sınırı
aşılmaz.

**3. Birleştirme ve dönüştürme (senin işlemcin).** `ffmpeg.wasm` ayrı bir Web Worker
içinde çalışır. Ayrı video ve ses akışları yeniden kodlanmadan (`-c copy`) tek
kapsayıcıya yazılır; MP3/WAV istenirse ses akışı yerel olarak kodlanır. MP4
kopyalaması codec uyumsuzluğu nedeniyle başarısız olursa kayıpsız şekilde MKV'ye
düşülür.

**4. Kaydetme.** Sonuç bir `Blob` olarak oluşturulur ve doğrudan diske yazılır.
İşlenmiş dosya hiçbir zaman sunucuya uğramaz.

---

## Ne destekleniyor?

### Platformlar

| Platform | Durum | Nasıl |
|---|---|---|
| **YouTube** | Çalışıyor, IP'ye bağlı (aşağıya bakın) | InnerTube oynatıcı ucu; imza çözümü gerektirmeyen iOS / Android-VR istemci bağlamları. HLS listesi 144p–2160p, ayrı akışlar 4K'ya kadar |
| **X / Twitter** | Çalışıyor | Herkese açık syndication ucu; HLS + MP4 varyantları |
| **Vimeo** | Çalışıyor | Oynatıcı yapılandırması (HLS, DASH, doğrudan MP4) |
| **Dailymotion** | Kısmen | Oynatıcı üst verisi; bazı videolarda akış listesi boş dönüyor |
| **Instagram** | Yalnızca çerezle | Anonim erişim tamamen kapalı (`login_required`) |
| **Reddit** | Pratikte hayır | Veri merkezi IP'lerini `403` ile reddediyor |

### Biçimler ve protokoller

- **Doğrudan dosyalar** — `.mp4`, `.webm`, `.mkv`, `.mov`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.flac`
- **HLS** (`.m3u8`) — çoklu kalite seçimi, ayrı ses parçaları, AES-128 şifreli akışlar
- **DASH** (`.mpd`) — `SegmentTemplate` (`$Number$` / `$Time$` / `SegmentTimeline`), `SegmentList`, `SegmentBase`
- **Ayrı video + ses akışları** — iki dosya paralel indirilip tarayıcıda birleştirilir
- **Gömülü videolu sayfalar** — `og:video`, JSON-LD, HTML5 `<video>`, iframe içindeki oynatıcılar

### Çıktı biçimleri

| Biçim | Ne yapar |
|---|---|
| **MP4** (önerilen) | Akışları yeniden kodlamadan kopyalar — hızlı, kalite kaybı yok |
| **MKV** | Aynı şekilde kopyalar, her codec'i kabul eden kapsayıcı |
| **MP4 (yeniden kodla)** | `libx264` + `aac` ile baştan kodlar — yavaş, en geniş uyumluluk |
| **MP3** | Yalnızca ses, `libmp3lame` 192 kbps |
| **M4A** | Yalnızca ses, yeniden kodlamadan |
| **WAV** | Yalnızca ses, sıkıştırmasız |
| **Orijinal** | Hiç işlem yapmaz, FFmpeg'i indirmez |

---

## Oturum çerezi (Instagram ve YouTube için)

Bazı platformlar sunucudan gelen anonim isteklere içerik vermez. Bunun tek çözümü,
isteğin senin kimliğinle yapılmasıdır — `yt-dlp`'nin `--cookies` seçeneğiyle aynı
mantık. Sitedeki **Gelişmiş** bölümüne kendi çerezini yapıştırabilirsin.

**Çerezin nereye gittiği:** yalnızca tarayıcının `localStorage`'ında saklanır, her
istekte `X-Site-Cookie` başlığıyla gönderilir ve fonksiyon onu hiçbir yere yazmadan
doğrudan hedef siteye iletir. Yine de bu, hesabına erişim veren bir bilgidir:
**kendi kurduğun kopyada kullan**, paylaşılan bir dağıtımda kullanma, işin bitince
temizle.

### YouTube ve bot kontrolü — ölçülen davranış

YouTube, bulut sağlayıcılarının IP adreslerine sıklıkla *"Sign in to confirm you're
not a bot"* döndürür. Çözümleyici, herkese açık service-worker ucundan alınan gerçek
bir `visitorData` kimliği sunarak bu kontrolü aşmaya çalışır ve ilk tur boş dönerse
kimliği tazeleyip bir kez daha dener.

Ölçüm sonuçları:

| Ortam | `visitorData` yok | `visitorData` var |
|---|---|---|
| Geliştirme konteyneri | 8 videonun 1'i | 4 videonun 4'ü |
| **Netlify (üretim)** | — | **5 videonun 1'i** |

Yani yöntem doğru çalışıyor ama Netlify'ın paylaşımlı AWS IP'leri ağır işaretlenmiş
durumda. Çerez eklendiğinde istek senin hesabın adına yapılır ve bu kontrol devreye
girmez. Kendi alan adında, farklı bir IP'den yayımlarsan oran da değişir.

---

## Ne desteklenmiyor?

Bunlar eksiklik değil, yöntemin sınırları:

- **DRM korumalı içerik** (Widevine, FairPlay, PlayReady — Netflix, Disney+, Spotify).
  Şifre çözme anahtarı tarayıcının güvenli medya yoluna aittir, sayfaya hiç verilmez.
  Hiçbir istemci tarafı yöntem bunu aşamaz.
- **Instagram, çerez olmadan.** Test edilen tüm anonim yollar (`api/v1/media/info`,
  GraphQL, gömülü oynatıcı) `login_required` veya `429` döndürüyor.
- **Reddit** — veri merkezi IP'lerinden gelen istekleri (Netlify dâhil) `403` ile
  reddediyor; çözümleyici var ama pratikte çoğu zaman boş döner.
- **Çok büyük dosyalar.** Dönüştürme tarayıcı belleğinde yapıldığı için ~1,5 GB
  üzerindeki videolarda bellek yetmeyebilir. Bu durumda **Orijinal** biçimini seç:
  dosya belleğe alınmadan doğrudan kaydedilir.
- **Bazı isteğe bağlı (on-demand) DASH profilleri.** Hiyerarşik `sidx` kutuları
  kullanan tek dosyalı yayınları `ffmpeg.wasm` çözemiyor; bu akışlar **Orijinal**
  biçimiyle indirilebilir ama dönüştürülemez.

---

## Proje yapısı

```
public/                     Netlify'a yayımlanan statik site
  index.html
  assets/app.css
  assets/app.js             arayüz orkestrasyonu
  assets/engine.js          parçalı indirme, HLS ve DASH ayrıştırıcıları
  assets/ffmpeg.js          ffmpeg.wasm köprüsü
  vendor/ffmpeg/            yapım sırasında üretilir (depoya girmez)

netlify/
  functions/resolve.mts     medya adaylarını çıkarır (platform çözümleyicileri dâhil)
  functions/proxy.mts       CORS aktarıcı
  lib/net.mts               SSRF koruması ve ortak başlıklar

scripts/vendor-ffmpeg.mjs   FFmpeg dosyalarını public/vendor'a kopyalar
netlify.toml                yapı, fonksiyon ve başlık ayarları

app.py, templates/          eski Flask sürümü (aşağıya bakın)
```

---

## Yerel geliştirme

```sh
npm install          # bağımlılıklar + FFmpeg paketleri
npm run build        # FFmpeg dosyalarını public/vendor altına kopyalar
npx netlify dev      # http://localhost:8888
```

`npm run build` her yapıda çalışır ve `public/vendor/ffmpeg/` içeriğini
`node_modules`'ten üretir. Bu klasör 32 MB'lik WebAssembly çekirdeğini içerdiği için
depoya eklenmez.

## Netlify'a yayımlama

Proje Netlify'da **`anything-video-downloader`** adıyla yayında. Depo bu projeye
bağlıysa `main` dalına gönderim yeterlidir. Elle yayımlamak için:

```sh
npx netlify deploy --build --prod
```

`netlify.toml` gerekli her şeyi taşır: yapı komutu, yayın klasörü, fonksiyon dizini
ve önbellek başlıkları. Ek ortam değişkeni veya gizli anahtar gerekmez.

---

## Güvenlik ve sınırlar

- **SSRF koruması.** Her iki fonksiyon da hedef adresi doğrular: yalnızca `http`/`https`,
  ve alan adı çözümlendikten sonra özel ağ aralıkları (`10/8`, `127/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, CGNAT, IPv6 yerel adresler) reddedilir. Bulut metadata
  uçlarına erişilemez.
- **Bant genişliği.** Video baytları proxy üzerinden geçtiği için Netlify'ın aylık
  bant genişliği kotasından düşer. Yoğun kullanımda kotayı izle.
- **Fonksiyon süresi.** Sunucu isteklerinin hepsi kısa tutulmuştur (4 MB parçalar,
  tek tek segmentler), böylece süre sınırına takılmaz.
- **Çerezler.** Sunucu hiçbir çerezi saklamaz veya günlüğe yazmaz; başlıktan alıp
  doğrudan hedef siteye iletir. Yine de bir oturum çerezi hesabına erişim verir —
  yalnızca kendi kurduğun kopyada kullan.
- **İçerik hakkı.** Bu araç yalnızca indirme hakkına sahip olduğun içerik için
  kullanılmalıdır. Telif hakkıyla korunan materyalin izinsiz indirilmesi ve
  dağıtılması sorumluluğu kullanıcıya aittir.

---

## Eski Flask sürümü

`app.py` ve `templates/` klasörü, `yt-dlp` tabanlı özgün sunucu uygulaması olarak
depoda duruyor. Kendi makinende çalıştırmak istersen:

```sh
pip install flask yt-dlp
sudo apt install ffmpeg      # veya: brew install ffmpeg
python app.py                # http://127.0.0.1:5000
```

`yt-dlp` binlerce siteyi destekler ve kendi bilgisayarında çalıştığı için IP tabanlı
bot kontrollerine de takılmaz; ancak sunucu tarafında Python, FFmpeg ve kalıcı disk
gerektirdiği için Netlify'da çalıştırılamaz. İki sürüm farklı ihtiyaçlar içindir:
kendi makinende `yt-dlp`, herkese açık ve sunucusuz dağıtımda bu tarayıcı tabanlı sürüm.

---

## Lisans

MIT
