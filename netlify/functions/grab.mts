/**
 * /al?u=<adres> ve /ses?u=<adres> — Kestirmeler icin kisa yol.
 *
 * Neden var: iOS, imzasiz kestirme dosyalarini ice aktarmayi tumden reddediyor
 * ("Imzalanmamis kestirmelerin dosyalarinin ice aktarilmasi desteklenmiyor"),
 * yani kestirme kullanicinin kendi telefonunda kurulmak zorunda. O yuzden
 * kurulumun kisa olmasi onemli.
 *
 * Adres, `u=` parametresinden sonraki **ham metnin tamami** olarak alinir:
 *
 *   /al?u=https://www.youtube.com/watch?v=abc&t=5
 *
 * Hedefin kendi sorgu dizesi (?v=...&t=...) boylece oldugu gibi korunur ve
 * kestirmede "URL Kodla" adimina gerek kalmaz. Kestirme uc eylemle kurulur:
 *
 *   Metin: https://site/al?u= + [Kestirme Girdisi]
 *   URL'nin Icerigini Al
 *   Fotograf Albumune Kaydet
 *
 * (Adres yolun icine konmuyor: Netlify yol normalizasyonu "/watch" gibi
 * parcalara "/index.htm" ekleyip hedefi bozuyor. Sorgu dizesi aynen geciyor.)
 *
 * Yanit dosyanin kendisine yonlendirmedir; Kestirme byte'lari dogrudan alir.
 */

import type { Config, Context } from "@netlify/functions";
import { assertSafeUrl, corsHeaders, HttpError } from "../lib/net.mjs";
import { resolvePage } from "../lib/resolver.mjs";
import { downloadUrl, pickOptions, safeFileName, type Wanted } from "../lib/shortcut-pick.mjs";

/**
 * Istek adresinden hedefi cozer: `u=` isaretinden sonrasi, sorgu ayraclari
 * dahil, ham metin olarak alinir. URL nesnesi kullanilmaz cunku o, hedefin
 * kendi `&` parametrelerini bizim parametrelerimiz sanip boler.
 */
function targetFromQuery(requestUrl: string): string {
  const at = requestUrl.indexOf("u=");
  if (at === -1) return "";

  let rest = requestUrl.slice(at + 2).trim();
  if (!rest) return "";

  // Kestirme adresi kodlayarak gondermisse (zorunlu degil ama zarari yok).
  if (/%3a%2f%2f|%3A%2F%2F/.test(rest)) {
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* bozuk kodlama: ham haliyle denenir */
    }
  }
  rest = rest.replace(/^(https?:)\/(?!\/)/i, "$1//");
  if (!/^https?:\/\//i.test(rest)) rest = `https://${rest}`;
  return rest;
}

/** Ses surumu ayri bir adreste: /ses?u=... */
function wantedFor(pathname: string): Wanted {
  return pathname.startsWith("/ses") ? "audio" : "video";
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(req.url);
  const origin = (() => {
    const host = req.headers.get("x-forwarded-host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return host ? `${proto}://${host}` : reqUrl.origin;
  })();

  /** Kestirme icinde okunmayacagi icin hatalar duz metin doner. */
  const fail = (status: number, message: string) =>
    new Response(`${message}\n`, {
      status,
      headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });

  const target = targetFromQuery(req.url);
  const wanted = wantedFor(reqUrl.pathname);
  if (!target) {
    return fail(400, "Adres eksik. Ornek: /al?u=https://ornek-site.com/video/123");
  }

  let pageUrl: URL;
  try {
    pageUrl = await assertSafeUrl(target);
  } catch (err) {
    const e = err as HttpError;
    return fail(e.status ?? 400, e.message);
  }

  const cookie = req.headers.get("x-site-cookie") || undefined;

  try {
    const page = await resolvePage(pageUrl, cookie);
    const best = pickOptions(page.candidates, wanted, 0)[0];

    if (!best) {
      const needsMerge = page.candidates.some(
        (c) => c.kind === "hls" || c.kind === "dash" || c.kind === "pair",
      );
      // Telefonda birlestirme yapilamiyor; kullanici siteye yonlendirilir.
      return fail(
        404,
        needsMerge
          ? // Siteye yonlendirirken kullanicinin verdigi adres kullanilir:
            // cozumleme sirasindaki son adres yonlendirmelerle degismis olabilir.
            `Bu videonun tek parca inen surumu yok (kalite parcalara bolunmus ya da video ile ses ayri). Telefonda birlestirilemez; siteden indir: ${origin}/?url=${encodeURIComponent(pageUrl.toString())}`
          : page.note || "Sayfada indirilebilir bir medya adresi bulunamadi.",
      );
    }

    const filename = safeFileName(page.title, best.ext);
    return new Response(null, {
      status: 302,
      headers: corsHeaders({
        Location: downloadUrl(origin, best.url, page.pageUrl, filename),
        "Cache-Control": "no-store",
      }),
    });
  } catch (err) {
    const e = err as HttpError;
    return fail(e.status ?? 500, e.message);
  }
};

export const config: Config = {
  path: ["/al", "/ses"],
};
