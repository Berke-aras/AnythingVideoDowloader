/**
 * /api/proxy — CORS aktarici.
 *
 * Tarayici, baska bir alan adindaki video dosyasini CORS nedeniyle dogrudan
 * okuyamaz. Bu fonksiyon yalnizca byte'lari aynen aktarir: cozme, birlestirme
 * veya donusturme yapmaz; o isler istemcide ffmpeg.wasm ile yapilir.
 *
 * Istemci dosyayi Range istekleriyle parcalar halinde ceker, boylece her
 * cagri kisa surer ve fonksiyon zaman asimina ugramaz.
 */

import type { Config, Context } from "@netlify/functions";
import {
  assertSafeUrl,
  corsHeaders,
  dispatcherFor,
  HttpError,
  mergeCookies,
  siteCookieFor,
  upstreamHeaders,
} from "../lib/net.mjs";

/**
 * Indirilen dosyanin adini tarayiciya/telefona bildirir (RFC 6266).
 *
 * ASCII disi karakterler icin iki bicim birden yazilir: tirnak icindeki sade
 * karsilik eski istemciler, `filename*` ise Turkce harfleri dogru gosteren
 * yeni istemciler icindir. Satir sonlari ve tirnaklar temizlenir; aksi halde
 * ad uzerinden yanit basligina veri sokusturulabilir.
 */
function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const safe = clean.slice(0, 120) || "video";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Yalnizca GET ve HEAD desteklenir.", {
      status: 405,
      headers: corsHeaders(),
    });
  }

  const params = new URL(req.url).searchParams;
  const target = params.get("url");
  if (!target) {
    return new Response("url parametresi gerekli.", { status: 400, headers: corsHeaders() });
  }

  let safe: URL;
  try {
    safe = await assertSafeUrl(target);
  } catch (err) {
    const e = err as HttpError;
    return new Response(e.message ?? "Gecersiz adres.", {
      status: e.status ?? 400,
      headers: corsHeaders(),
    });
  }

  const headers = upstreamHeaders(safe, params.get("ref"));
  const range = req.headers.get("range");
  if (range) headers.Range = range;
  // Sikistirilmis yanit istemiyoruz: govde burada acildigi icin kaynaktan gelen
  // Content-Length ile aktarilan byte sayisi birbirini tutmaz, dosya kirpilir.
  // Medya dosyalari zaten sikistirilmis oldugundan kayip da olmaz.
  headers["Accept-Encoding"] = "identity";
  // Yas kapisi cerezleri (varsa) ve kullanicinin kendi oturum cerezi yalnizca
  // hedef siteye iletilir. Bazi siteler medya baytlarini da yalnizca onay
  // cerezi varken veriyor, bu yuzden cozumlemede oldugu gibi burada da lazim.
  const ref = params.get("ref");
  let refHost = "";
  try {
    refHost = ref ? new URL(ref).hostname : "";
  } catch {
    /* gecersiz referer yok sayilir */
  }
  const cookie = mergeCookies(
    siteCookieFor(safe.hostname),
    refHost ? siteCookieFor(refHost) : "",
    req.headers.get("x-site-cookie"),
  );
  if (cookie) headers.Cookie = cookie;

  let upstream: Response;
  try {
    upstream = await fetch(safe, {
      method: req.method,
      headers,
      redirect: "follow",
      dispatcher: await dispatcherFor(safe),
    } as RequestInit);
  } catch (err) {
    return new Response(`Kaynak adrese ulasilamadi: ${(err as Error).message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const out = corsHeaders({
    "X-Final-Url": upstream.url || safe.toString(),
    "Cache-Control": "no-store",
  });
  // Dosya adi: /api/shortcut bunu ekler, cunku Kisayollar ve iOS paylasim
  // sayfasi adi yalnizca yanit basligindan okuyabiliyor. Tarayici arayuzu
  // dosyayi kendi adlandirdigi icin bu parametreyi hic gondermez.
  const name = params.get("name");
  if (name) out["Content-Disposition"] = contentDisposition(name);

  const encoding = (upstream.headers.get("content-encoding") || "identity").toLowerCase();
  const passthrough = ["content-type", "content-range", "accept-ranges", "last-modified", "etag"];
  // Kaynak yine de sikistirilmis dondurduyse Content-Length acilmis govdeyi
  // tanimlamaz; iletmemek, yanlis uzunluk bildirmekten iyidir.
  if (encoding === "identity") passthrough.push("content-length");

  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  if (!out["content-type"]) out["content-type"] = "application/octet-stream";

  // Netlify'in uc katmani govdesiz yanitlarda Content-Length'i kaldiriyor.
  // Istemcinin dosyayi parcalara bolebilmesi icin uzunlugu ayrica bildiriyoruz.
  const length = upstream.headers.get("content-length");
  if (encoding === "identity" && length) out["x-upstream-length"] = length;

  return new Response(req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
};

export const config: Config = {
  path: "/api/proxy",
};
