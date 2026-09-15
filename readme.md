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
(YouTube, X, Instagram, Vimeo, Dailymotion, Reddit, PornHub ailesi, XHamster,
SpankBang, Eporner). Değilse sayfanın HTML'ini okur:
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
| **YouTube** | Yerel yardımcıyla çalışıyor; yardımcısız IP'ye bağlı | InnerTube oynatıcı ucu; imza çözümü gerektirmeyen iOS / Android-VR istemci bağlamları. HLS listesi 144p–2160p, ayrı akışlar 4K'ya kadar |
| **X / Twitter** | Çalışıyor | Herkese açık syndication ucu; HLS + MP4 varyantları |
| **Vimeo** | Çalışıyor | Oynatıcı yapılandırması (HLS, DASH, doğrudan MP4) |
| **Dailymotion** | Kısmen | Oynatıcı üst verisi; bazı videolarda akış listesi boş dönüyor |
| **Instagram** | Çalışıyor | Instagram'ın kendi uçları oturum ister; herkese açık gönderiler için genel bir embed servisinin yönlendirmesinden CDN adresi alınır |
| **Reddit** | Çalışıyor | Reddit'in sayfası engellense de medya sunucusu `v.redd.it` açık; video kimliği alınıp tüm kaliteleri içeren HLS/DASH listesi kuruluyor |
| **Yetişkin siteleri** | Çalışıyor | Yaş kapısı çerezleri otomatik gönderilir. PornHub / RedTube / YouPorn / Tube8 için `mediaDefinitions`, XHamster için `window.initials`, SpankBang için `stream_data`, Eporner için imzalı XHR ucu; XVideos, XNXX, TNAFlix ve **KVS motorlu yüzlerce tüp sitesi** genel yoldan. Canlı test: PornHub, RedTube, XVideos, XHamster, TNAFlix, Eporner, KVS demo |
| **KVS motorlu siteler** | Çalışıyor | Yüzlerce tüp sitesinin ortak altyapısı. `flashvars` içindeki adres `function/0/...` ile karıştırılmışsa `license_code`'dan üretilen anahtarla açılır (oynatıcının yaptığı işlemin aynısı) |
| **Rastgele siteler** | Genellikle çalışıyor | `og:video`, JSON-LD, HTML5 `<video>`, JW Player / Video.js `sources`, gömülü oynatıcılar, uzantısız adreslerin içerik türüyle doğrulanması ve son çare metin taraması |

### Biçimler ve protokoller

- **Doğrudan dosyalar** — `.mp4`, `.webm`, `.mkv`, `.mov`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.flac`
- **HLS** (`.m3u8`) — çoklu kalite seçimi, ayrı ses parçaları, AES-128 şifreli akışlar
- **DASH** (`.mpd`) — `SegmentTemplate` (`$Number$` / `$Time$` / `SegmentTimeline`), `SegmentList`, `SegmentBase`
- **Ayrı video + ses akışları** — iki dosya paralel indirilip tarayıcıda birleştirilir
- **Gömülü videolu sayfalar** — `og:video`, JSON-LD, HTML5 `<video>`, iframe içindeki oynatıcılar
- **Oynatıcı yapılandırmaları** — JW Player / Video.js `sources: [{file}]`, `setVideoUrlHigh()`, `mediaDefinitions`, `window.initials` gibi JS içine gömülü adresler

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

## Telefonda kullanım

Site telefonda da tam çalışır; mobil için ayrıca şunlar var:

**Ana ekrana ekle → paylaşım menüsüne girer.** Tarayıcı menüsünden siteyi ana ekrana
eklediğinde bir web uygulaması olarak kurulur ve **paylaşım menüsünde görünür**.
YouTube, Instagram ya da X uygulamasında *Paylaş → AnythingVideoDownloader* dediğin
anda bağlantı siteye gelir ve çözümleme kendiliğinden başlar. (Manifest'teki
`share_target` bunu sağlar; Android'de bağlantı çoğu zaman `url` yerine `text`
içinde geldiği için metnin içinden de adres çıkarılır.)

**Kaydetme iOS'ta farklı çalışır.** iPhone'da `<a download>` ile blob kaydetmek
güvenilir değildir — Safari dosyayı kaydetmek yerine yeni sekmede açar. Bu yüzden
mobilde indirme bitince otomatik kaydetme yapılmaz; **"Telefona kaydet"** düğmesi
çıkar ve dokununca sistemin paylaşım sayfası açılır (*Dosyalara Kaydet*, *Videoyu
Kaydet*…). Paylaşım API'si dosya desteklemiyorsa düğme klasik indirmeye düşer.
Düğme gerekli çünkü paylaşım sayfası ancak bir dokunmayla açılabilir.

**Ekran sönmesin.** İşlem sekmede çalıştığı için indirme ve dönüştürme boyunca
Wake Lock ile ekranın sönmesi engellenir. Yine de sekmeyi kapatırsan işlem durur.

**Bellek.** Telefon belleği dardır; 600 MB üzerinde uyarı verilir. İşlem çökerse
**Orijinal** biçimi seç — dosya dönüştürülmeden kaydedilir, FFmpeg hiç indirilmez.

**Küçük kolaylıklar.** Panodan **Yapıştır** düğmesi, dokunma hedeflerinin
büyütülmesi, alanların 16 px yazı boyu (iOS'un odaklanınca sayfayı yakınlaştırmasını
engeller) ve masaüstüne ait bölümlerin (yerel yardımcı) gizlenmesi.

Yerel yardımcı telefonda çalışmaz (Python + yt-dlp gerekir), bu yüzden mobilde
YouTube sunucu tarafındaki çözümleyiciye bağlıdır.

---

## iPhone Kısayolu (Shortcuts)

iPhone'da paylaşım menüsünden **tek dokunuşla** indirmek için hazır bir kısayol var:
**[`/shortcuts`](https://anything-video-downloader.netlify.app/shortcuts)** sayfasındaki
düğme `shortcuts://import-shortcut` ile Kısayollar uygulamasını açar ve "Kısayol Ekle"
ekranını gösterir — eylemleri elle dizmek gerekmez. Sayfada elle kurulum tarifi de yedek
olarak duruyor.

Kısayol dosyasını `/avd.shortcut` ucu üretir (`?type=audio` ses sürümünü verir). Dosya
sunucuda üretiliyor çünkü **sitenin kendi adresi** kısayolun içine gömülmek zorunda:
projeyi kendi Netlify hesabına kuran birinin kısayolu kendi alan adına istek atsın diye.
İçerik bir XML plist'tir; eylemler UUID ile birbirine bağlanır, `WFWorkflowTypes:
["ActionExtension"]` ile paylaşım sayfasına yerleşir.

Kurulan kısayolun akışı: *paylaşılan adres → URL kodla → `/api/shortcut` → `result` "ok" ise
dosyayı indirip Fotoğraflar'a kaydet, değilse Türkçe açıklamayı bildir ve adresi dolu olarak
siteyi aç.*

> **İmzasız dosya uyarısı.** Apple imzalamadığı için iOS kurulumdan önce *Ayarlar →
> Kestirmeler → **Özel Paylaşma*** ayarının açık olmasını ister (eski iOS sürümlerinde adı
> *Güvenilmeyen Kısayollara İzin Ver* idi; ayar görünmüyorsa önce herhangi bir kestirmeyi bir
> kez çalıştırmak gerekir). Sonra kurulum önizlemesinde eylem listesinin en altına kadar kaydırıp
> **Kestirmeyi Ekle** düğmesine basılır — iOS bu incelemeyi bilerek zorunlu tutuyor.
>
> Tamamen sürtünmesiz kurulum isteyen, kestirmeyi bir kez telefona alıp **iCloud bağlantısı**
> olarak paylaşabilir: iCloud bağlantıları Apple tarafından imzalandığı için hiçbir uyarı
> çıkmaz. Elle kurulan kestirme de güvenilir sayılır, hiçbir ayar gerektirmez.

Uç, `/api/resolve` ile aynı çözümlemeyi yapar; farkı **seçim** aşamasındadır: Kısayollar
uygulaması ffmpeg çalıştıramadığı için yalnızca **tek parçada inen** adaylar değerlendirilir
(HLS/DASH ve "video + ses ayrı" olanlar elenir), kalanlar arasından telefonun oynatabildiği
biçim (mp4/m4v/mov) ve en yüksek çözünürlük seçilir.

```
GET /api/shortcut?url=<sayfa>              →  JSON: {ok, title, filename, url, webUrl, ...}
GET /api/shortcut?url=<sayfa>&redirect=1   →  302: dosyanın kendisi (Kısayol byte'ları alır)
```

| Parametre | Ne yapar |
| --- | --- |
| `url` | Çözümlenecek adres. POST gövdesinde düz metin / JSON / form olarak da kabul edilir; paylaşılan metnin içine gömülü ilk adres bulunur. |
| `redirect=1` | JSON yerine doğrudan dosyaya yönlendirir. |
| `type=audio` | Video yerine ses dosyası seçer (`type=any` ikisini birden değerlendirir). |
| `max=720` | Bu yüksekliğin üstündeki kaliteleri eler. |
| `list=1` | Uygun tüm seçenekleri `options` dizisinde döner (Kısayol'da "Listeden Seç" için). |
| `strict=1` | Hatalarda gerçek HTTP kodu döner. |
| `X-Site-Cookie` başlığı | Gizli gönderiler ve YouTube bot kontrolü için kendi oturum çerezin. |

Yanıt **varsayılan olarak her zaman 200** döner; başarı bilgisi gövdedeki `ok` alanında, ayrıca
Kısayol'un "Eğer" koşulunda karşılaştırdığı `result` alanında (`"ok"` / `"error"`) düz metin
olarak bulunur:
Kısayollar 2xx dışındaki yanıtlarda akışı okunmaz bir hatayla durdurur, böyleyse kullanıcıya
Türkçe açıklama (`message`) gösterilebiliyor. İndirme adresi `/api/proxy`'ye `name=` ile gider;
proxy de `Content-Disposition` yazdığı için dosya telefonda doğru adla kaydedilir.

**Sınır ve çözümü.** Birleştirme gerektiren videolarda (çoğu YouTube videosu) uç
`ok: false`, `needsMerge: true` ve adresi önceden doldurulmuş `webUrl` döner. Sayfadaki
**gelişmiş tarif** bunu kullanır: dosya varsa kaydeder, yoksa siteyi açar ve birleştirmeyi
tarayıcıdaki ffmpeg.wasm yapar. Sunucuda mux yapılmaz — projenin bütün mantığı ağır işi
istemcide tutmaktır.

---

## Rastgele sitelerde nasıl davranıyor?

Bilinen bir platform değilse çözümleyici sayfayı sırayla şu yollardan tarar ve ilk
güvenilir sonuçta durur:

1. `og:video` / `twitter:player:stream` meta etiketleri
2. JSON-LD `contentUrl`
3. HTML5 `<video>` / `<source>` etiketleri
4. **Oynatıcı yapılandırmaları** — JW Player, Video.js ve benzerlerinin JS içindeki
   `file` / `src` / `videoUrl` / `hlsUrl` / `video_alt_url` / `240p` alanları
   (anahtar ve değer tek ya da çift tırnaklı olabilir), `sources: [...]` dizileri,
   `setVideoUrlHigh(...)` çağrıları
5. **KVS motoru** — `flashvars` nesnesi varsa tüm kaliteleri, gerekiyorsa adresin
   karıştırılmış bölümünü çözerek
6. **Yaş kapısı** — sayfa medyasız döndüyse ve içerik "18 yaşından büyük müsün"
   sorusuna benziyorsa, onay çerezleriyle bir kez daha istenir
7. Gömülü oynatıcılar (`<iframe>`, bir seviye) — artık yalnızca hiç aday yokken
   değil, **güvenilir** aday yokken de takip edilir; birçok sitede sayfada sadece
   önizleme klibi olur, asıl video iframe içindedir
8. **Uzantısız adreslerin doğrulanması** — oynatıcı yapılandırmasından çıkan ama
   dosya uzantısı olmayan adresler (tokenli CDN uçları, `/get_file/...`, `/master`)
   tek baytlık bir istekle yoklanır; içerik türü `video/…`, `audio/…` ya da
   `mpegurl` ise listeye alınır
9. Son çare: tüm belgede medya uzantısı taraması

**Gürültü elemesi:** son çare taraması yalnızca üstteki yollardan hiçbiri sonuç
vermediğinde kullanılır. Aksi hâlde öneri kutularındaki başka videoların önizlemeleri
listeye dolardı — bir sitede 40 aday çıkıp yalnızca 2'si gerçek videoyken bunu ölçüp
düzelttik. Tek istisna taramadan çıkan **HLS/DASH listeleri**: bunlar asla önizleme
klibi olmaz ve bazı sitelerde asıl kaynak yalnızca orada görünür, bu yüzden listede
kalırlar. Ayrıca önizleme/küçük resim adresleri (`/thumbs/`, `preview.mp4`,
`526x298...`, `sprite`) her durumda elenir.

---

## Yaş kapısı olan siteler nasıl çözülüyor?

Yetişkin içerikli siteler videoyu yalnızca "18 yaşından büyüğüm" onayından sonra
sayfaya koyar. Onay bir çerezde tutulur; çerez yoksa sunucuya gelen sayfa boştur ve
içinde hiç medya adresi bulunmaz — eskiden bu sitelerde "video bulunamadı" denmesinin
sebebi buydu.

Çözüm iki katmanlı:

1. **Bilinen siteler** (`netlify/lib/net.mts` içindeki liste) için onay çerezleri
   isteğe doğrudan eklenir — tarayıcıda "giriş" düğmesine basınca oluşan çerezlerin
   aynısı. Oturum, hesap ya da kişisel veri içermezler.
2. **Listede olmayan siteler** için sayfa önce çerezsiz istenir; medya bulunamaz ve
   sayfa bir yaş kapısına benziyorsa genel onay çerezleriyle bir kez daha denenir.

Aynı çerezler `/api/proxy` üzerinden de gider: bazı siteler yalnızca sayfayı değil,
video baytlarını da onay çerezi olmadan vermiyor.

**Sıcak bağlantı koruması.** Medya isteklerinde `Referer` sayfanın adresi, `Origin`
da o adresin kaynağı olarak gönderilir (eskiden `Origin` hedefin kendi adresiydi ve
bazı CDN'ler bunu tutarsız bulup `403` dönüyordu).

---

## Instagram nasıl çözülüyor?

Instagram'ın kendi uçlarının hepsi anonim isteklere kapalı — test edilen üç yol da
(`api/v1/media/info`, GraphQL, gömülü oynatıcı) `login_required` veya `429` döndürüyor.
Bu yüzden son adımda, sohbet uygulamalarının Instagram önizlemesi için kullandığı genel
bir embed servisi devreye giriyor: gönderi adresi verilince doğrudan Instagram
CDN'indeki dosyaya `302` ile yönlendiriyor. Çözümleyici yalnızca bu **yönlendirmedeki
adresi** alır; video baytları o servisten geçmez, senin tarayıcın CDN'den indirir.

Bunun bedeli şeffaf olmalı: bu adımda **gönderi kimliği üçüncü bir tarafa gönderilir**
ve yalnızca Instagram'ın kendi uçları sonuç vermediğinde çalışır. Çerez verirsen o yol
önce denenir ve embed servisine hiç gidilmez. Gizli hesaplardaki gönderiler bu yolla da
inmez.

## Oturum çerezi (gizli içerik ve YouTube için)

Bazı platformlar sunucudan gelen anonim isteklere içerik vermez. Bunun tek çözümü,
isteğin senin kimliğinle yapılmasıdır — `yt-dlp`'nin `--cookies` seçeneğiyle aynı
mantık. Sitedeki **Gelişmiş** bölümüne kendi çerezini yapıştırabilirsin.

**Çerezin nereye gittiği:** yalnızca tarayıcının `localStorage`'ında saklanır, her
istekte `X-Site-Cookie` başlığıyla gönderilir ve fonksiyon onu hiçbir yere yazmadan
doğrudan hedef siteye iletir. Yine de bu, hesabına erişim veren bir bilgidir:
**kendi kurduğun kopyada kullan**, paylaşılan bir dağıtımda kullanma, işin bitince
temizle.

## YouTube'u güvenilir hâle getirmek: yerel yardımcı

**yt-dlp'nin bir numarası yok.** Aynı konteynerde IP işaretlendiği anda yt-dlp de
birebir aynı hatayı verdi:

```
ERROR: [youtube] Sign in to confirm you're not a bot.
Use --cookies-from-browser or --cookies for the authentication.
```

Farkı tek şey: yt-dlp normalde **senin kendi bağlantından** çalışır ve ev IP'leri
işaretli değildir. Bu yüzden en sağlam çözüm, aynı şeyi burada da yapmak:

```sh
pip install yt-dlp
python3 tools/avd-helper.py
```

Yardımcı `127.0.0.1:8765` üzerinde dinler. Siteyi açtığında sayfa onu kendisi bulur
ve üst köşede **"Yerel yardımcı bağlı"** yazar. O andan itibaren:

| | Yardımcı kapalı | Yardımcı açık |
|---|---|---|
| Adres çözümü | Netlify fonksiyonu | Senin makinende `yt-dlp` |
| Medya baytları | Netlify proxy'si | Doğrudan senin bağlantın |
| YouTube | IP'ye bağlı, çoğu videoda engel | Çalışır |
| Netlify bant genişliği | Kullanılır | **Hiç kullanılmaz** |
| Birleştirme / dönüştürme | Tarayıcı | Tarayıcı (değişmez) |

Yaş sınırı olan ya da gizli içerik için yardımcıya çerezleri tarayıcından
aldırabilirsin:

```sh
python3 tools/avd-helper.py --cookies-from-browser chrome
```

**Güvenlik:** yardımcı yalnızca `127.0.0.1` üzerinde dinler (dışarıdan erişilemez),
yalnızca izin verilen web adreslerinden gelen isteklere yanıt verir ve özel ağ
adreslerine istek atmayı reddeder. Tarayıcılar `127.0.0.1`'i güvenli kaynak saydığı
için HTTPS sayfadan yerel yardımcıya bağlanmak engellenmez.

*Doğrulandı:* yardımcı açıkken bir X gönderisi uçtan uca indirildi — HLS segmentleri
yerel bağlantıdan çekildi, tarayıcıda birleştirildi, 2,68 MB geçerli MP4 kaydedildi.

---

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
durumda. Piped ve Invidious gibi genel YouTube ön yüzleri de aynı engele takıldığı için
(`YouTube probably temporarily blocked`) onlar da çare değil.

Engelin **IP seviyesinde** olduğunu doğrulamak için Netlify'da geçici bir teşhis ucu
yayımladım. Sonuç net — istemci profili hiç fark etmiyor:

| Denenen | Sonuç |
|---|---|
| iOS, Android-VR, TVHTML5, TV-embedded, WEB-Safari, MWEB (visitorData ile ve olmadan) | Hepsi `LOGIN_REQUIRED` |
| İzleme sayfası HTML'i (`ytInitialPlayerResponse`) | `LOGIN_REQUIRED` |
| Netlify Edge Function (Deno, farklı çıkış IP'si) | `LOGIN_REQUIRED` |
| Tarayıcıdan doğrudan çağrı | `Origin` başlığında `403`, CORS yok |
| Piped / Invidious genel örnekleri | `403`, `502`, "YouTube probably temporarily blocked" |

Üç çözüm var:

1. **Yerel yardımcı** (yukarıdaki bölüm) — en sağlamı, çerez bile gerekmez.
2. **Çerez.** Gelişmiş bölümüne YouTube çerezini yapıştır; istek senin hesabın adına
   yapılır ve bot kontrolü devreye girmez.
3. **Kendi çıkış proxy'n.** Netlify proje ayarlarında bir ortam değişkeni tanımla:

   | Değişken | Anlamı |
   |---|---|
   | `UPSTREAM_PROXY` | `http://kullanici:parola@sunucu:port` — istekler buradan çıkar |
   | `UPSTREAM_PROXY_HOSTS` | İsteğe bağlı. Varsayılan: `youtube.com,youtu.be,googlevideo.com,ytimg.com`. `*` yazarsan tüm trafik proxy'den geçer |

   Varsayılan olarak **yalnızca YouTube alan adları** yönlendirilir; diğer sitelerin
   trafiği doğrudan gider, böylece proxy bant genişliğin boşa harcanmaz. YouTube akış
   adresleri, oynatıcı isteğini yapan IP'ye bağlandığı için video baytları da aynı
   proxy'den geçer — proxy'nin kotasını buna göre seç.

   Rastgele bulunmuş ücretsiz proxy'ler kullanma: tüm trafiği görebilir ve
   değiştirebilirler. Kendi sunucun ya da güvendiğin bir sağlayıcı olsun.

---

## Ne desteklenmiyor?

Bunlar eksiklik değil, yöntemin sınırları:

- **DRM korumalı içerik** (Widevine, FairPlay, PlayReady — Netflix, Disney+, Spotify).
  Şifre çözme anahtarı tarayıcının güvenli medya yoluna aittir, sayfaya hiç verilmez.
  Hiçbir istemci tarafı yöntem bunu aşamaz.
- **Gizli hesaplardaki içerik.** Instagram'ın herkese açık gönderileri çözülüyor ama
  gizli bir hesabın gönderisi için o hesaba erişimi olan bir çerez gerekir.
- **Reddit'in kendi API'si** — veri merkezi IP'lerini reddediyor. Video indirmek
  için gerek yok (medya sunucusu açık), ama gönderi başlığı bazen adresteki
  slug'dan türetilir.
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
  shortcuts.html            iPhone Kısayolu kurulum rehberi
  assets/app.css
  assets/app.js             arayüz orkestrasyonu
  assets/shortcuts.js       kısayol sayfası (adres doldurma + deneme kutusu)
  assets/engine.js          parçalı indirme, HLS ve DASH ayrıştırıcıları
  assets/ffmpeg.js          ffmpeg.wasm köprüsü
  manifest.webmanifest      ana ekrana ekleme + paylaşım hedefi
  sw.js                     uygulama kabuğu önbelleği
  icons/                    yapım sırasında üretilir
  vendor/ffmpeg/            yapım sırasında üretilir (depoya girmez)

netlify/
  functions/resolve.mts     /api/resolve — çözümleyiciyi çağırır, JSON döner
  functions/shortcut.mts    /api/shortcut — iPhone Kısayolu için tek dosyalık kaynak seçer
  functions/shortcut-file.mts  /avd.shortcut — kurulabilir kısayol dosyasını üretir
  functions/proxy.mts       CORS aktarıcı
  lib/resolver.mts          medya adaylarını çıkarır (platform çözümleyicileri dâhil)
  lib/shortcut-file.mts     kısayol plist'ini kurar (eylemler, UUID bağları)
  lib/net.mts               SSRF koruması ve ortak başlıklar

tools/avd-helper.py         yerel yardımcı (yt-dlp ile çözüm + bayt aktarımı)
scripts/make-icons.mjs      uygulama simgelerini üretir (bağımlılıksız PNG)
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
- **Üçüncü taraf servis.** Instagram çözümü, Instagram'ın kendi uçları sonuç
  vermediğinde genel bir embed servisine gönderi kimliğini gönderir. Video baytları
  oradan geçmez, yalnızca adres alınır.
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
