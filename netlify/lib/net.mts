/**
 * Fonksiyonlar arasinda paylasilan ag yardimcilari.
 *
 * Buradaki tek gercek is guvenliktir: site herkese acik oldugu icin proxy'nin
 * ic aglara veya loopback adreslerine istek atmasina (SSRF) izin verilmemelidir.
 */

import { lookup } from "node:dns/promises";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / bulut metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
  if (v.startsWith("::ffff:")) return isPrivateIPv4(v.slice(7));
  return false;
}

/**
 * Kullanicidan gelen adresi dogrular. Gecerliyse normalize edilmis URL doner,
 * degilse hata firlatir.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Gecersiz URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Yalnizca http ve https adresleri desteklenir.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new HttpError(403, "Bu adrese erisim engellendi.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) throw new HttpError(403, "Ozel ag adresleri engellendi.");
    return url;
  }
  if (host.includes(":")) {
    if (isPrivateIPv6(host)) throw new HttpError(403, "Ozel ag adresleri engellendi.");
    return url;
  }
  try {
    const records = await lookup(host, { all: true });
    for (const r of records) {
      const priv = r.family === 6 ? isPrivateIPv6(r.address) : isPrivateIPv4(r.address);
      if (priv) throw new HttpError(403, "Ozel ag adresleri engellendi.");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Alan adi cozumlenemedi.");
  }
  return url;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Tarayicidan gelen istekler icin gereken CORS basliklari. */
export function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type, X-Site-Cookie",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, " +
      "X-Final-Url, X-Upstream-Length",
    ...extra,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

/* ------------------------- istege bagli cikis proxy'si ------------------------- */

/**
 * YouTube, bulut saglayicilarinin IP adreslerini bot olarak isaretliyor. Site
 * sahibi kendi guvendigi bir proxy'yi UPSTREAM_PROXY ortam degiskenine
 * yazarsa, o platformlara giden istekler oradan cikar.
 *
 * Varsayilan olarak yalnizca YouTube alan adlari yonlendirilir; boylece diger
 * sitelerin trafigi ve bant genisligi bosuna proxy'den gecmez.
 * UPSTREAM_PROXY_HOSTS ile bu liste degistirilebilir (virgulle ayrilmis).
 */
const DEFAULT_PROXY_HOSTS = ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"];

let cachedAgent: { key: string; agent: Promise<unknown> } | null = null;

function proxySettings(): { url: string; hosts: string[] } | null {
  const url = process.env.UPSTREAM_PROXY?.trim();
  if (!url) return null;
  const raw = process.env.UPSTREAM_PROXY_HOSTS?.trim();
  const hosts = raw
    ? raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PROXY_HOSTS;
  return { url, hosts };
}

/**
 * Hedef, proxy kapsamindaysa kullanilacak undici dispatcher'ini doner.
 * Yapilandirma yoksa undefined doner ve istek dogrudan gider.
 *
 * undici bilerek tembel yukleniyor: modul yuklendigi anda kendi global
 * dispatcher'ini kuruyor ve ortamda tanimli proxy ayarlarini devre disi
 * birakiyor. Yalnizca UPSTREAM_PROXY tanimliyken devreye girmesi gerekiyor.
 */
export async function dispatcherFor(target: URL): Promise<unknown | undefined> {
  const settings = proxySettings();
  if (!settings) return undefined;

  const host = target.hostname.toLowerCase();
  const inScope =
    settings.hosts.includes("*") ||
    settings.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!inScope) return undefined;

  if (cachedAgent?.key !== settings.url) {
    cachedAgent = {
      key: settings.url,
      agent: import("undici").then((undici) => new undici.ProxyAgent(settings.url)),
    };
  }
  return cachedAgent.agent;
}

/** Hedef siteye tarayici gibi gorunen istek basliklari uretir. */
export function upstreamHeaders(target: URL, referer?: string | null): Record<string, string> {
  const ref = referer || `${target.protocol}//${target.host}/`;
  let origin = "";
  try {
    origin = new URL(ref).origin;
  } catch {
    /* referer bozuksa Origin gonderilmez */
  }
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
    Referer: ref,
    "Sec-Fetch-Dest": "video",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
  };
  // Origin, sayfanin kendi adresinden turetilir. Daha once hedefin kendi
  // adresi yaziliyordu; hotlink korumasi olan CDN'ler bunu tutarsiz bulup
  // 403 donduruyordu.
  if (origin && origin !== `${target.protocol}//${target.host}`) headers.Origin = origin;
  return headers;
}

/* ---------------------------- yas kapisi cerezleri ---------------------------- */

/**
 * Yetiskin icerikli siteler (ve bazi haber siteleri) videoyu yalnizca "18
 * yasindan buyugum" onayindan sonra sayfaya koyar. Onay bir cerezle tutulur;
 * cerez yoksa sunucuya bos bir uyari sayfasi doner ve icinde hic medya adresi
 * bulunmaz. Asagidaki cerezler tarayicida "giris" dugmesine basildiginda
 * olusan cerezlerin aynisidir: oturum, hesap ya da kisisel veri icermezler.
 */
const SITE_COOKIES: Array<[RegExp, string]> = [
  // Aylo ailesi: PornHub, RedTube, YouPorn, Tube8, Thumbzilla
  [
    /(^|\.)pornhub(premium)?\.(com|org|net)$/,
    "age_verified=1; accessAgeDisclaimerPH=1; accessAgeDisclaimerUK=1; accessPH=1; adblock_message_displayed=1; cookiesBannerSeen=1; platform=pc; hasVisited=1",
  ],
  [
    /(^|\.)(redtube|youporn|tube8|thumbzilla)\.com$/,
    "age_verified=1; accessAgeDisclaimerET=1; accessAgeDisclaimerUK=1; platform=pc; hasVisited=1",
  ],
  // XHamster ve alan adi kopyalari (xhamster2.com, xhamster42.desi ...)
  [/(^|\.)xhamster\w*\.(com|desi|one)$/, "age_verified=1; platform=pc; lang=en"],
  // XVideos / XNXX: masaustu surumu ve yas onayi
  [/(^|\.)(xvideos\w*|xnxx\w*)\.(com|es)$/, "age_verified=1; platform=pc; ts=1"],
  [/(^|\.)spankbang\.(com|party)$/, "age_pass=1; country=US; ui_lang=en"],
  [/(^|\.)eporner\.com$/, "age_verified=1; dwhsh=1"],
  [/(^|\.)(txxx|upornia|hclips|hotmovs|porntrex|vjav)\.com$/, "age_verified=1; kt_is_visited=1"],
  [/(^|\.)(motherless|beeg|tnaflix|empflix|drtuber|nuvid|sunporno)\.com$/, "age_verified=1"],
];

/**
 * Bilinmeyen siteler icin genel yas kapisi cerezleri. Sayfa ilk denemede
 * medyasiz dondugunde ikinci deneme bunlarla yapilir: farkli sitelerin
 * kullandigi yaygin onay cerez adlarinin birlesimidir.
 */
export const GENERIC_AGE_COOKIE =
  "age_verified=1; ageVerified=1; age_gate=1; ageGate=1; over18=1; is_adult=1; adult=1; " +
  "confirmed=1; ageConfirmed=1; disclaimer=1; warning=1; platform=pc; lang=en; hasVisited=1";

/** Hedef alan adi icin otomatik gonderilecek cerezler (yoksa bos dizi). */
export function siteCookieFor(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const [match, cookie] of SITE_COOKIES) {
    if (match.test(h)) return cookie;
  }
  return "";
}

/** Iki cerez dizisini, ayni ada sahip olanlarda ikinciyi ustun tutarak birlestirir. */
export function mergeCookies(...parts: Array<string | null | undefined>): string {
  const map = new Map<string, string>();
  for (const part of parts) {
    for (const piece of (part ?? "").split(";")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const name = trimmed.split("=")[0].trim().toLowerCase();
      if (name) map.set(name, trimmed);
    }
  }
  return [...map.values()].join("; ");
}
