/**
 * /api/shortcut — iPhone "Kisayollar" (Shortcuts) ucu.
 *
 * Kisayollar uygulamasi ffmpeg calistiramaz: HLS/DASH segmentlerini
 * birlestiremez, ayri video ve ses akislarini mux'layamaz. Bu yuzden buradaki
 * is, cozumleyicinin buldugu adaylar arasindan **tek parcada inen** bir dosya
 * secmek ve onu telefona dogrudan verilebilecek bicimde dondurmektir.
 *
 * Iki kullanim bicimi var:
 *   /api/shortcut?url=...              -> JSON (baslik, dosya adi, indirme adresi)
 *   /api/shortcut?url=...&redirect=1   -> dosyanin kendisine 302 ("Sayfa
 *                                         Icerigini Al" byte'lari dogrudan alir)
 *
 * Yanit varsayilan olarak her zaman 200 doner; basari bilgisi govdedeki `ok`
 * alanindadir. Kisayollar 2xx disindaki yanitlarda akisi okunmaz bir hatayla
 * durdurdugu icin boylesi kullaniciya Turkce aciklama gostermeye izin verir.
 * Gercek HTTP kodlarini isteyen istemciler `strict=1` ekler.
 */

import type { Config, Context } from "@netlify/functions";
import { assertSafeUrl, corsHeaders, HttpError, jsonResponse } from "../lib/net.mjs";
import { resolvePage, type Candidate, type ResolveResult } from "../lib/resolver.mjs";

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

const AUDIO_EXT = new Set(["m4a", "mp3", "aac", "ogg", "oga", "opus", "wav", "flac"]);
const PHOTOS_EXT = new Set(["mp4", "m4v", "mov"]);

/** Etiket ya da adresten okunabilen dikey cozunurluk (yoksa 0). */
function heightOf(c: Candidate): number {
  const m = `${c.label} ${c.url}`.match(/(\d{3,4})\s*[pP]\b|\b(2160|1440|1080|720|480|360|240)\b/);
  return Number(m?.[1] ?? m?.[2] ?? 0);
}

/** Dosya sisteminde ve paylasim sayfasinda sorun cikarmayan bir ad uretir. */
function safeFileName(title: string, ext: string): string {
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
function urlFromText(text: string): string {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? "";
}

/** Istegin sorgusundan ya da govdesinden hedef adresi bulur. */
async function targetFrom(req: Request, params: URLSearchParams): Promise<string> {
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

type Wanted = "video" | "audio" | "any";

/** Tek parcada inebilen adaylari istenen ture gore siralar. */
function pickOptions(candidates: Candidate[], wanted: Wanted, maxHeight: number): Candidate[] {
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
function downloadUrl(origin: string, media: string, page: string, filename: string): string {
  const q = new URLSearchParams({ url: media, ref: page, name: filename });
  return `${origin}/api/proxy?${q}`;
}

function flagOf(params: URLSearchParams, name: string): boolean {
  return /^(1|true|yes|evet)$/i.test(params.get(name) || "");
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(req.url);
  const params = reqUrl.searchParams;
  const origin = reqUrl.origin;
  const wantsRedirect = flagOf(params, "redirect");
  const strict = flagOf(params, "strict");

  const askedType = (params.get("type") || params.get("format") || "").trim();
  const wanted: Wanted = /^(audio|ses|mp3|m4a)$/i.test(askedType)
    ? "audio"
    : /^(any|hepsi|all)$/i.test(askedType)
      ? "any"
      : "video";
  const maxHeight = Number(params.get("max") || params.get("quality") || 0) || 0;

  /** Hata yanitlari: Kisayol akisini kirmamak icin varsayilan olarak 200. */
  const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => {
    if (wantsRedirect) {
      // Yonlendirme modunda govde dosya olarak bekleniyor; JSON yerine duz
      // metin dondurulur ki telefonda bozuk bir dosya kaydedilmesin.
      return new Response(`${message}\n`, {
        status: strict ? status : 404,
        headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }
    // `result` alani `ok` ile ayni bilgiyi duz metin olarak tasir: Kisayollar
    // mantiksal degerleri cihaza gore 1/0/true diye gosterdigi icin "Eger"
    // kosulunu metin uzerinden kurmak daha guvenli.
    return jsonResponse(
      { ok: false, result: "error", status, message, ...extra },
      strict ? status : 200,
    );
  };

  const target = await targetFrom(req, params);
  if (!target) {
    return fail(
      400,
      "Bir adres gonderilmedi. Kisayolda 'url' parametresine paylasilan baglantiyi ver.",
    );
  }

  let pageUrl: URL;
  try {
    pageUrl = await assertSafeUrl(target);
  } catch (err) {
    const e = err as HttpError;
    return fail(e.status ?? 400, e.message);
  }

  // Kullanici kendi oturum cerezini basliga koyabilir; hicbir yerde saklanmaz.
  const cookie = req.headers.get("x-site-cookie") || undefined;
  const webUrl = `${origin}/?url=${encodeURIComponent(pageUrl.toString())}`;

  let page: ResolveResult;
  try {
    page = await resolvePage(pageUrl, cookie);
  } catch (err) {
    const e = err as HttpError;
    return fail(e.status ?? 500, e.message, { webUrl });
  }

  const options = pickOptions(page.candidates, wanted, maxHeight);
  const best = options[0];

  if (!best) {
    // Aday olabilir ama hepsi HLS/DASH ya da "video + ses" ikilisidir: bunlar
    // ancak tarayicida ffmpeg.wasm ile birlestirilebilir, telefonda degil.
    const needsMerge = page.candidates.some(
      (c) => c.kind === "hls" || c.kind === "dash" || c.kind === "pair",
    );
    const message = needsMerge
      ? "Bu videonun tek parca inen bir surumu yok: kalite parcalara bolunmus (HLS/DASH) ya da video ile ses ayri geliyor. Birlestirme telefonda yapilamiyor, siteyi acip indir."
      : page.note ||
        (wanted === "audio"
          ? "Sayfada ayri bir ses dosyasi bulunamadi."
          : "Sayfada indirilebilir bir medya adresi bulunamadi.");
    return fail(404, message, {
      title: page.title,
      page: page.pageUrl,
      webUrl,
      needsMerge,
    });
  }

  const filename = safeFileName(page.title, best.ext);
  const download = downloadUrl(origin, best.url, page.pageUrl, filename);

  if (wantsRedirect) {
    return new Response(null, {
      status: 302,
      headers: corsHeaders({ Location: download, "Cache-Control": "no-store" }),
    });
  }

  const describe = (c: Candidate) => {
    // Listede birden fazla secenek varsa dosya adlari birbirine karismasin.
    const height = heightOf(c);
    const name = safeFileName(height ? `${page.title} ${height}p` : page.title, c.ext);
    return {
      label: c.label,
      ext: c.ext,
      type: c.kind === "audio" || AUDIO_EXT.has(c.ext) ? "audio" : "video",
      height: height || null,
      filename: name,
      url: downloadUrl(origin, c.url, page.pageUrl, name),
    };
  };

  return jsonResponse({
    ok: true,
    /** Kisayol'un "Eger" kosulu bunu okur (bkz. fail icindeki not). */
    result: "ok",
    title: page.title,
    filename,
    ext: best.ext,
    type: best.kind === "audio" || AUDIO_EXT.has(best.ext) ? "audio" : "video",
    quality: best.label,
    height: heightOf(best) || null,
    /** Kisayol'un indirecegi adres: dosya adi yanit basliginda yazili gelir. */
    url: download,
    /** Ayni dosyanin kaynaktaki hali (aktarici olmadan). */
    source: best.url,
    page: page.pageUrl,
    poster: page.poster || "",
    /** Dogrudan "Videoyu Kaydet" ile Fotograflar'a girebilir mi? */
    savesToPhotos: PHOTOS_EXT.has(best.ext),
    /** Kisayol basarisiz olursa acilacak site adresi (adres onceden dolu). */
    webUrl,
    note: page.note || "",
    ...(flagOf(params, "list") ? { options: options.slice(0, 10).map(describe) } : {}),
  });
};

export const config: Config = {
  path: "/api/shortcut",
  method: ["GET", "POST", "OPTIONS"],
};
