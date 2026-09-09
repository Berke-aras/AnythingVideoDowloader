#!/usr/bin/env python3
"""
AnythingVideoDownloader — yerel yardimci.

Neden var:
    YouTube, bulut saglayicilarinin IP adreslerini bot olarak isaretliyor. Bu
    yuzden sunucu tarafindaki cozumleyici cogu videoda "Sign in to confirm
    you're not a bot" yaniti aliyor. yt-dlp'nin bu sorunu yasamamasinin sebebi
    bir numara degil: senin kendi baglantindan calisiyor olmasi.

    Bu yardimci de aynisini yapar. Kendi bilgisayarinda calisir, adres cozumunu
    yt-dlp ile yapar ve medya baytlarini senin baglantindan aktarir. Site
    acikken yardimciyi bulursa otomatik olarak onu kullanir; bulamazsa
    sunucudaki cozumleyiciye doner.

    Video yine tarayicida birlestirilip donusturulur; bu yardimci yalnizca
    "adres bul" ve "byte aktar" isini yapar. Netlify'in bant genisligi de hic
    kullanilmaz.

Kurulum ve calistirma:
    pip install yt-dlp
    python3 tools/avd-helper.py

    Sonra siteyi ac: https://anything-video-downloader.netlify.app

Guvenlik:
    - Yalnizca 127.0.0.1 uzerinde dinler, disaridan erisilemez.
    - Yalnizca izin verilen web adreslerinden gelen isteklere yanit verir
      (--allow-origin ile degistirilebilir).
    - Ozel ag adreslerine (yerel ag, bulut metadata uclari) istek atmayi
      reddeder.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8765
DEFAULT_ORIGINS = [
    "https://anything-video-downloader.netlify.app",
    "http://localhost:8888",
    "http://localhost:8899",
    "http://127.0.0.1:8888",
    "http://127.0.0.1:8899",
]

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

AUDIO_EXTS = {"m4a", "mp3", "aac", "ogg", "opus", "wav", "flac", "webm"}


# --------------------------------------------------------------------------- #
# Guvenlik
# --------------------------------------------------------------------------- #

def is_public_address(hostname: str) -> bool:
    """Adres genel internete mi ait? Yerel ag ve metadata uclari reddedilir."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    return True


def check_target(raw_url: str) -> str:
    """Hedef adresi dogrular; gecerliyse oldugu gibi doner."""
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Yalnizca http ve https adresleri desteklenir.")
    if not parsed.hostname:
        raise ValueError("Adreste alan adi yok.")
    if not is_public_address(parsed.hostname):
        raise ValueError("Ozel ag adresleri engellendi.")
    return raw_url


# --------------------------------------------------------------------------- #
# yt-dlp ile cozumleme
# --------------------------------------------------------------------------- #

def quality_label(fmt: dict) -> str:
    height = fmt.get("height")
    note = fmt.get("format_note") or ""
    fps = fmt.get("fps")
    parts = []
    if height:
        parts.append(f"{height}p{int(fps) if fps and fps > 30 else ''}")
    elif note:
        parts.append(note)
    if fmt.get("vcodec") and fmt["vcodec"] != "none":
        parts.append(fmt["vcodec"].split(".")[0])
    if fmt.get("tbr"):
        parts.append(f"{int(fmt['tbr'])} kbps")
    return " - ".join(p for p in parts if p) or "bilinmeyen"


def audio_label(fmt: dict) -> str:
    parts = []
    if fmt.get("abr"):
        parts.append(f"{int(fmt['abr'])} kbps")
    if fmt.get("acodec") and fmt["acodec"] != "none":
        parts.append(fmt["acodec"].split(".")[0])
    return " - ".join(parts) or "ses"


def resolve_with_ytdlp(url: str, cookies_from_browser: str | None) -> dict:
    """yt-dlp'nin cikardigi bicimleri sitenin bekledigi aday listesine cevirir."""
    import yt_dlp

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    if cookies_from_browser:
        options["cookiesfrombrowser"] = (cookies_from_browser,)

    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)

    if info.get("_type") == "playlist" and info.get("entries"):
        info = next((e for e in info["entries"] if e), info)

    formats = [f for f in (info.get("formats") or []) if f.get("url")]
    candidates: list[dict] = []

    # 1) HLS / DASH listeleri: tarayici kalite secimini kendisi yapabilir.
    for fmt in formats:
        proto = fmt.get("protocol") or ""
        if fmt.get("manifest_url") and "m3u8" in proto:
            manifest = fmt["manifest_url"]
            if not any(c["url"] == manifest for c in candidates):
                candidates.append({
                    "url": manifest,
                    "kind": "hls",
                    "ext": "m3u8",
                    "label": "Tum kaliteler - HLS, kalite secilebilir",
                    "source": "yt-dlp",
                    "rank": 0,
                })
            break

    # 2) Video ve sesi birlikte iceren tek dosyalar.
    for fmt in sorted(
        (f for f in formats if f.get("vcodec") not in (None, "none")
         and f.get("acodec") not in (None, "none")
         and "m3u8" not in (f.get("protocol") or "")),
        key=lambda f: (f.get("height") or 0, f.get("tbr") or 0),
        reverse=True,
    )[:6]:
        candidates.append({
            "url": fmt["url"],
            "kind": "video",
            "ext": fmt.get("ext") or "mp4",
            "label": f"{quality_label(fmt)} - video+ses tek dosya",
            "source": "yt-dlp",
            "rank": 0,
        })

    # 3) Ayri video ve ses akislari: en yuksek cozunurluk burada bulunur.
    videos = sorted(
        (f for f in formats if f.get("vcodec") not in (None, "none")
         and f.get("acodec") in (None, "none")
         and "m3u8" not in (f.get("protocol") or "")),
        key=lambda f: (f.get("height") or 0, f.get("tbr") or 0),
        reverse=True,
    )
    audios = sorted(
        (f for f in formats if f.get("acodec") not in (None, "none")
         and f.get("vcodec") in (None, "none")
         and "m3u8" not in (f.get("protocol") or "")),
        key=lambda f: (f.get("abr") or 0),
        reverse=True,
    )

    if videos and audios:
        candidates.append({
            "url": "",
            "kind": "pair",
            "ext": "mp4",
            "label": f"Video + ses birlestir - {quality_label(videos[0]).split(' - ')[0]} kaliteye kadar",
            "source": "yt-dlp",
            "rank": 0,
            "videoOptions": [
                {"url": f["url"], "ext": f.get("ext") or "mp4", "label": quality_label(f)}
                for f in videos[:12]
            ],
            "audioOptions": [
                {"url": f["url"], "ext": f.get("ext") or "m4a", "label": audio_label(f)}
                for f in audios[:6]
            ],
        })

    if audios:
        best = audios[0]
        candidates.append({
            "url": best["url"],
            "kind": "audio",
            "ext": best.get("ext") if best.get("ext") in AUDIO_EXTS else "m4a",
            "label": f"Yalnizca ses - {audio_label(best)}",
            "source": "yt-dlp",
            "rank": 0,
        })

    return {
        "pageUrl": info.get("webpage_url") or url,
        "title": info.get("title") or "",
        "poster": info.get("thumbnail") or "",
        "note": "" if candidates else "yt-dlp bu adreste indirilebilir bir bicim bulamadi.",
        "candidates": candidates,
        "via": "yerel yardimci (yt-dlp)",
    }


# --------------------------------------------------------------------------- #
# HTTP sunucusu
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "avd-helper"

    # Sunucu ayarlari (main icinde doldurulur)
    allowed_origins: list[str] = []
    cookies_from_browser: str | None = None

    def log_message(self, fmt: str, *args) -> None:  # daha sade gunluk
        sys.stderr.write(f"  {self.address_string()} - {fmt % args}\n")

    # ---------------------------- yardimcilar ---------------------------- #

    def _origin_allowed(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin is None:
            return "*"  # tarayici disi istekler (curl ile deneme)
        return origin if origin in self.allowed_origins else None

    def _cors(self, origin: str) -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type, X-Site-Cookie",
            "Access-Control-Expose-Headers":
                "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Upstream-Length",
            "Vary": "Origin",
        }

    def _send(self, status: int, headers: dict[str, str], body: bytes | None) -> None:
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        if body is not None:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body is not None and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, origin: str, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = self._cors(origin)
        headers["Content-Type"] = "application/json; charset=utf-8"
        headers["Cache-Control"] = "no-store"
        self._send(status, headers, body)

    # ------------------------------ yollar ------------------------------- #

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self._origin_allowed()
        if origin is None:
            self._send(403, {}, b"")
            return
        self._send(204, self._cors(origin), b"")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        origin = self._origin_allowed()
        if origin is None:
            self._send(403, {}, b"Bu adresten gelen isteklere izin verilmiyor.")
            return

        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/health":
            self._json(200, origin, {"ok": True, "name": "avd-helper", "version": 1})
            return

        if parsed.path == "/resolve":
            target = (params.get("url") or [""])[0]
            if not target:
                self._json(400, origin, {"error": "url parametresi gerekli."})
                return
            try:
                check_target(target)
                self._json(200, origin, resolve_with_ytdlp(target, self.cookies_from_browser))
            except Exception as err:  # yt-dlp cok cesitli hata firlatir
                self._json(502, origin, {"error": f"{type(err).__name__}: {err}"})
            return

        if parsed.path == "/fetch":
            self._proxy((params.get("url") or [""])[0], origin)
            return

        self._json(404, origin, {"error": "Bilinmeyen yol."})

    def _proxy(self, target: str, origin: str) -> None:
        """Medya baytlarini kullanicinin kendi baglantisindan aktarir."""
        if not target:
            self._json(400, origin, {"error": "url parametresi gerekli."})
            return
        try:
            check_target(target)
        except ValueError as err:
            self._json(403, origin, {"error": str(err)})
            return

        request = urllib.request.Request(target, method=self.command)
        request.add_header("User-Agent", BROWSER_UA)
        request.add_header("Accept", "*/*")
        request.add_header("Accept-Encoding", "identity")
        rng = self.headers.get("Range")
        if rng:
            request.add_header("Range", rng)

        try:
            upstream = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as err:
            upstream = err
        except Exception as err:
            self._json(502, origin, {"error": f"Kaynak adrese ulasilamadi: {err}"})
            return

        headers = self._cors(origin)
        headers["Cache-Control"] = "no-store"
        for name in ("Content-Type", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
            value = upstream.headers.get(name)
            if value:
                headers[name] = value
        length = upstream.headers.get("Content-Length")
        if length:
            headers["Content-Length"] = length
            headers["X-Upstream-Length"] = length
        headers.setdefault("Content-Type", "application/octet-stream")

        self.send_response(upstream.status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()

        if self.command == "HEAD":
            upstream.close()
            return
        try:
            while chunk := upstream.read(256 * 1024):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # tarayici indirmeyi iptal etti
        finally:
            upstream.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="AnythingVideoDownloader yerel yardimcisi")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"varsayilan: {DEFAULT_PORT}")
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="Ek izinli web adresi (birden fazla kez verilebilir)",
    )
    parser.add_argument(
        "--cookies-from-browser",
        metavar="TARAYICI",
        help="Cerezleri tarayicidan al (chrome, firefox, edge, brave, safari...). "
             "Yas siniri olan veya gizli icerik icin gerekir.",
    )
    args = parser.parse_args()

    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        print("HATA: yt-dlp kurulu degil.  Kurmak icin:  pip install yt-dlp", file=sys.stderr)
        return 1

    Handler.allowed_origins = DEFAULT_ORIGINS + args.allow_origin
    Handler.cookies_from_browser = args.cookies_from_browser

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True

    print(f"AnythingVideoDownloader yardimcisi hazir:  http://127.0.0.1:{args.port}")
    print("  Bu pencereyi acik birak ve siteyi ac; site yardimciyi kendisi bulur.")
    print("  Izin verilen adresler:")
    for origin in Handler.allowed_origins:
        print(f"    - {origin}")
    if args.cookies_from_browser:
        print(f"  Cerezler {args.cookies_from_browser} tarayicisindan alinacak.")
    print("  Durdurmak icin Ctrl+C.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nYardimci kapatildi.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
