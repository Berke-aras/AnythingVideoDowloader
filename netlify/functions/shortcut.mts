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
import {
  AUDIO_EXT,
  downloadUrl,
  heightOf,
  PHOTOS_EXT,
  pickOptions,
  safeFileName,
  targetFrom,
  type Wanted,
} from "../lib/shortcut-pick.mjs";

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
