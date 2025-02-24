# Flask Video İndirme Uygulaması

Bu uygulama, kullanıcıların çeşitli platformlardan (Instagram, X, YouTube, TikTok vb.) video ve ses dosyalarını indirip, formatlarını seçmelerine olanak tanıyan bir Flask tabanlı web uygulamasıdır.

## Özellikler

-   Kullanıcıdan video URL'sini alarak format bilgilerini getirir.
-   Video, ses veya her ikisini birleştirerek indirme seçenekleri sunar.
-   İndirme işlemlerini takip edip, ilerleme durumunu gösterir.
-   İndirilen dosyaları otomatik olarak temizler.

## Gereksinimler

-   Python 3
-   Flask
-   yt-dlp
-   FFmpeg

## Kurulum

1. Gerekli bağımlılıkları yükleyin:
    ```sh
    pip install flask yt-dlp
    ```
2. FFmpeg'in sisteminizde kurulu olduğundan emin olun. Eğer kurulu değilse:
    - Windows: [FFmpeg İndir](https://ffmpeg.org/download.html)
    - Linux/Mac:
        ```sh
        sudo apt install ffmpeg  # Ubuntu/Debian
        brew install ffmpeg  # macOS
        ```
3. Proje dizinine gidin ve uygulamayı çalıştırın:
    ```sh
    python app.py
    ```

## Kullanım

-   Tarayıcınızı açın ve `http://127.0.0.1:5000` adresine gidin.
-   Video URL'sini girin ve uygun formatı seçin.
-   İndirme işleminin durumunu takip edin ve tamamlandığında dosyayı indirin.

## Yapılacaklar

-   Kullanıcı yetkilendirme eklemek
-   Daha fazla video platformunu desteklemek
-   Arayüzü geliştirmek

## Lisans

Bu proje MIT Lisansı ile lisanslanmıştır.
