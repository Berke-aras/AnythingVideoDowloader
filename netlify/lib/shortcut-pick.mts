/**
 * Kestirme uclarinin ortak mantigi.
 *
 * Kestirmeler (Shortcuts) uygulamasi ffmpeg calistiramaz: HLS/DASH
 * segmentlerini birlestiremez, ayri video ve ses akislarini mux'layamaz. Bu
 * yuzden telefona verilecek aday secilirken **tek parcada inen** dosyalar
 * disindaki her sey elenir.
 *
 * Hem /api/shortcut (JSON ucu) hem de /al/ (kisa yol) bu secimi kullanir.
 */

import type { Candidate } from "./resolver.mjs";

/** Kisayollar'in tek parcada indirebilecegi turler. */
const SINGLE_FILE_KINDS = new Set(["video", "audio"]);

/**
 * Uzanti tercihi. iOS'un "Videoyu Kaydet" adimi yalnizca mp4/m4v/mov kabul
 * eder; webm ve mkv ancak Dosyalar'a kaydedilir. Bu yuzden ayni cozunurlukte
 * iki aday varsa telefonun oynatabildigi kazanir.
 */
const EXT_RANK: Record<string, number> = {
  mp4: 0,
  m4v: 0,
  mov: 0,
  m4a: 0,
  mp3: 0,
  aac: 1,
  webm: 2,
  mkv: 2,
  ogg: 2,
  oga: 2,
  opus: 2,
  wav: 2,
  flac: 2,
  ts: 3,
};

export const AUDIO_EXT = new Set(["m4a", "mp3", "aac", "ogg", "oga", "opus", "wav", "flac"]);
export const PHOTOS_EXT = new Set(["mp4", "m4v", "mov"]);

/** Etiket ya da adresten okunabilen dikey cozunurluk (yoksa 0). */
export function heightOf(c: Candidate): number {
  const m = `${c.label} ${c.url}`.match(/(\d{3,4})\s*[pP]\b|\b(2160|1440|1080|720|480|360|240)\b/);
  return Number(m?.[1] ?? m?.[2] ?? 0);
}

/** Dosya sisteminde ve paylasim sayfasinda sorun cikarmayan bir ad uretir. */
export function safeFileName(title: string, ext: string): string {
  const base =
    (title || "video")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ")
      .slice(0, 70)
      .replace(/\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|m4a|mp3|aac|ogg|opus|wav|flac)$/i, "")
      .replace(/^[.\s-]+|[.\s-]+$/g, "") || "video";
  return `${base}.${ext || "mp4"}`;
}

/**
 * Paylasim sayfasindan gelen metin cogu zaman "su videoya bak https://..."
 * bicimindedir; icinden ilk adresi cikarir.
 */
export function urlFromText(text: string): string {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? "";
}

/** Istegin sorgusundan ya da govdesinden hedef adresi bulur. */
export async function targetFrom(req: Request, params: URLSearchParams): Promise<string> {
  const fromQuery = params.get("url") || params.get("text") || params.get("input") || "";
  if (fromQuery.trim()) return urlFromText(fromQuery) || fromQuery.trim();
  if (req.method !== "POST") return "";

  const body = await req.text();
  if (!body.trim()) return "";
  const type = req.headers.get("content-type") || "";

  if (/json/i.test(type)) {
    try {
      const data = JSON.parse(body);
      const value = data?.url ?? data?.text ?? data?.input ?? "";
      if (typeof value === "string" && value.trim()) return urlFromText(value) || value.trim();
    } catch {
      /* JSON degilse asagida duz metin gibi ele alinir */
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) {
    const form = new URLSearchParams(body);
    const value = form.get("url") || form.get("text") || "";
    if (value.trim()) return urlFromText(value) || value.trim();
  }
  return urlFromText(body) || body.trim();
}

export type Wanted = "video" | "audio" | "any";

/** Tek parcada inebilen adaylari istenen ture gore siralar. */
export function pickOptions(candidates: Candidate[], wanted: Wanted, maxHeight: number): Candidate[] {
  const isAudio = (c: Candidate) => c.kind === "audio" || AUDIO_EXT.has(c.ext);
  return candidates
    .filter((c) => SINGLE_FILE_KINDS.has(c.kind))
    .filter((c) => (wanted === "any" ? true : wanted === "audio" ? isAudio(c) : !isAudio(c)))
    .filter((c) => !maxHeight || heightOf(c) === 0 || heightOf(c) <= maxHeight)
    .sort(
      (a, b) =>
        (EXT_RANK[a.ext] ?? 2) - (EXT_RANK[b.ext] ?? 2) ||
        heightOf(b) - heightOf(a) ||
        a.rank - b.rank,
    );
}

/** Kisayol'un dogrudan indirebilecegi (hotlink korumasina takilmayan) adres. */
export function downloadUrl(origin: string, media: string, page: string, filename: string): string {
  const q = new URLSearchParams({ url: media, ref: page, name: filename });
  return `${origin}/api/proxy?${q}`;
}
