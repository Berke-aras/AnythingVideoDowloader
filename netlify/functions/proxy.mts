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
import { assertSafeUrl, corsHeaders, HttpError, upstreamHeaders } from "../lib/net.mjs";

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
  // Kullanicinin kendi oturum cerezi (varsa) yalnizca hedef siteye iletilir.
  const cookie = req.headers.get("x-site-cookie");
  if (cookie) headers.Cookie = cookie;

  let upstream: Response;
  try {
    upstream = await fetch(safe, { method: req.method, headers, redirect: "follow" });
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
