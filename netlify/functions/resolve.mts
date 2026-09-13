/**
 * /api/resolve — sayfadaki medya adaylarini bulur.
 *
 * Sadece HTML/JSON metnini okur ve icindeki medya adreslerini cikarir; video
 * byte'larina hic dokunmaz. Boylece sunucu tarafi hem hizli hem de ucuz kalir,
 * asil yuk (indirme + birlestirme + donusturme) istemciye birakilir.
 */

import type { Config, Context } from "@netlify/functions";
import {
  assertSafeUrl,
  dispatcherFor,
  GENERIC_AGE_COOKIE,
  HttpError,
  jsonResponse,
  mergeCookies,
  siteCookieFor,
  upstreamHeaders,
} from "../lib/net.mjs";

const MEDIA_EXT =
  "m3u8|mpd|mp4|m4v|mov|webm|mkv|m4a|mp3|aac|ogg|oga|opus|wav|flac|ts";
const MEDIA_URL_RE = new RegExp(
  `https?://[^\\s"'<>\\\\)\\]}]+?\\.(?:${MEDIA_EXT})(?:\\?[^\\s"'<>\\\\)\\]}]*)?`,
  "gi",
);
const MAX_HTML_BYTES = 4_000_000;
const MAX_CANDIDATES = 40;

type Kind = "hls" | "dash" | "pair" | "video" | "audio";

interface StreamOption {
  url: string;
  label: string;
  ext: string;
}

interface Candidate {
  url: string;
  kind: Kind;
  label: string;
  source: string;
  ext: string;
  rank: number;
  /** kind === "pair" oldugunda: istemcide birlestirilecek ayri akislar. */
  videoOptions?: StreamOption[];
  audioOptions?: StreamOption[];
}

/** Guvenilirlik sirasi: siteye ozel API > isaretleme > ham metin taramasi. */
const SOURCE_RANK: Record<string, number> = {
  "site-api": 0,
  dogrudan: 0,
  "content-type": 0,
  meta: 1,
  "json-ld": 1,
  link: 1,
  html5: 2,
  oynatici: 2,
  tarama: 3,
};

function extOf(u: string): string {
  // Sondaki egik cizgi yok sayilir: bircok tup sitesi adresi
  // ".../1234.mp4/?rnd=..." bicimimde uretiyor.
  const clean = u.split("#")[0].split("?")[0].replace(/\/+$/, "");
  const m = clean.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "";
}

function kindOf(u: string): Kind {
  const ext = extOf(u);
  if (ext === "m3u8") return "hls";
  if (ext === "mpd") return "dash";
  if (["m4a", "mp3", "aac", "ogg", "oga", "opus", "wav", "flac"].includes(ext)) return "audio";
  return "video";
}

function labelFor(u: string, kind: Kind): string {
  const res = u.match(/(\d{3,4})p|_(\d{3,4})x(\d{3,4})|\/(240|360|480|540|720|1080|1440|2160)\//i);
  const quality = res ? (res[1] || res[4] || res[3] || "") : "";
  const base = kind === "hls" ? "HLS akisi" : kind === "dash" ? "DASH akisi" : kind === "audio" ? "Ses" : "Video";
  const name = decodeURIComponent(u.split("#")[0].split("?")[0].split("/").pop() || "");
  const shortName = name.length > 46 ? name.slice(0, 43) + "..." : name;
  return [base, quality ? `${quality}p` : "", shortName].filter(Boolean).join(" · ");
}

function absolutize(base: string, u: string): string | null {
  try {
    const abs = new URL(u, base).toString();
    return abs.startsWith("http") ? abs : null;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  "#39": "'",
  // Bazi siteler baslikta noktalama isaretlerini de varlik olarak yaziyor.
  comma: ",",
  period: ".",
  excl: "!",
  quest: "?",
  colon: ":",
  semi: ";",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  num: "#",
  dollar: "$",
  percnt: "%",
  ast: "*",
  plus: "+",
  equals: "=",
  sol: "/",
  bsol: "\\",
  verbar: "|",
  commat: "@",
  lowbar: "_",
  hyphen: "-",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
  deg: "°",
  eacute: "é",
  laquo: "\u00ab",
  raquo: "\u00bb",
};

/** HTML varlik referanslarini (&amp; &#x27; &#039; ...) coz. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** JSON ve HTML kacis dizilerini cozerek gizlenmis adresleri gorunur yapar. */
function unescapeAll(text: string): string {
  return decodeEntities(
    text
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/"),
  );
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? m[1] : null;
}

interface FetchOptions {
  referer?: string;
  cookie?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** true ise istek bir sayfa gezintisi gibi gorunur (HTML isteyen siteler icin). */
  asPage?: boolean;
}

/**
 * Sayfa istekleri gercek bir adres cubugu gezintisi gibi gorunmeli: bircok
 * site (ozellikle Cloudflare arkasindakiler) her turu kabul eden bir Accept
 * basligiyla gelen istegi bot sayip bos sayfa ya da 403 donduruyor.
 */
const PAGE_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

async function fetchText(url: URL, timeoutMs: number, options: FetchOptions = {}) {
  const headers: Record<string, string> = {
    ...upstreamHeaders(url, options.referer),
    ...(options.asPage ? PAGE_HEADERS : {}),
    ...(options.headers ?? {}),
  };
  if (options.asPage && options.referer) headers["Sec-Fetch-Site"] = "same-origin";
  const cookie = mergeCookies(siteCookieFor(url.hostname), options.cookie);
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body,
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: await dispatcherFor(url),
  } as RequestInit);
  const type = res.headers.get("content-type") || "";
  const reader = res.body?.getReader();
  let text = "";
  let total = 0;
  if (reader) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (total >= MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return { text, type, finalUrl: res.url || url.toString(), status: res.status };
}

/**
 * Onizleme, kucuk resim ve sablon adresleri: bunlar oynatilacak video degil,
 * sayfadaki oneri kutularinin ustune gelince oynayan kisa kliplerdir. Ozellikle
 * uzun oneri listeleri olan sitelerde aday listesini bogarlar.
 */
const PREVIEW_RE = new RegExp(
  [
    "/(?:thumbs?|thumbnails?|preview(?:s)?|gifs?|sprites?|pics|posters?)/", // klasor adlari
    "\\bpreview[-_.]", // preview.mp4, preview_1.mp4
    "\\b\\d{2,3}x\\d{2,3}\\.", // 526x298.94.3.5.t.mp4 gibi kucuk kareler
    "\\.t\\.(?:av1\\.)?mp4$", // xhamster onizleme adlandirmasi
    "_TPL_", // doldurulmamis sablon
    "sprite",
  ].join("|"),
  "i",
);

/**
 * Uzantisi olmayan ama medya olabilecek adresler. Cok sayida site (tokenli
 * CDN'ler, `/get_file/...`, `/master`, `/videoplayback` gibi uclar) dosya
 * uzantisi kullanmaz; bunlar dogrudan listeye alinamaz, once icerik turune
 * bakilir. Aday listesiyle ayni omurde yasamalari icin listeye baglanirlar.
 */
const LOOSE = new WeakMap<Map<string, Candidate>, Map<string, string>>();

/** Medya olmadigi adresinden belli olan dosyalar. */
const NON_MEDIA_RE =
  /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|xml|txt|html?|php|woff2?|ttf|pdf|zip|rar|vtt|srt)(?:[?#]|$)/i;

function noteLoose(out: Map<string, Candidate>, url: string, source: string) {
  if (!/^https?:\/\//.test(url) || NON_MEDIA_RE.test(url) || PREVIEW_RE.test(url)) return;
  if (url.length > 600) return;
  let bag = LOOSE.get(out);
  if (!bag) LOOSE.set(out, (bag = new Map()));
  if (bag.size < 12 && !bag.has(url)) bag.set(url, source);
}

function looseOf(out: Map<string, Candidate>): Map<string, string> {
  return LOOSE.get(out) ?? new Map();
}

function collect(
  out: Map<string, Candidate>,
  base: string,
  raw: string | null | undefined,
  source: string,
  label?: string,
) {
  if (!raw) return;
  const abs = absolutize(base, unescapeAll(raw).trim());
  if (!abs) return;
  const ext = extOf(abs);
  if (!new RegExp(`^(?:${MEDIA_EXT})$`).test(ext)) {
    // Uzantisiz adresler elenmez, ayri torbaya konur: sonra icerik turune
    // bakilarak gercekten medya olup olmadiklari anlasilir.
    if (source !== "tarama") noteLoose(out, abs, source);
    return;
  }
  if (ext === "ts") return; // tek segment; tam video degil
  if (PREVIEW_RE.test(abs)) return;
  if (out.has(abs) || out.size >= MAX_CANDIDATES) return;
  const kind = kindOf(abs);
  out.set(abs, {
    url: abs,
    kind,
    label: label ?? labelFor(abs, kind),
    source,
    ext,
    rank: SOURCE_RANK[source] ?? 3,
  });
}

/**
 * Oynatici yapilandirmalarinda medya adresini tutan anahtarlar. Bircok site
 * adresi isaretlemeye degil, JS icindeki bir nesneye koyar:
 *   JW Player / Video.js : sources: [{ file: "..." }], { src: "..." }
 *   XVideos / XNXX       : html5player.setVideoUrlHigh('...'), setVideoHLS('...')
 *   Aylo (PornHub ailesi): "mediaDefinitions": [{ "videoUrl": "..." }]
 *   XHamster             : window.initials -> sources.mp4 / sources.hls
 *   Kvs tabanli tupler   : video_url, video_alt_url, video_url_text
 * Anahtar adi hem tirnakli hem tirnaksiz, deger hem tek hem cift tirnakli
 * olabilir; ikisi de kabul edilir.
 */
const PLAYER_KEYS =
  "file|src|url|uri|video_?url|video_?alt_?url|video_?url_?\\d*|videoUrlHigh|videoUrlLow|" +
  "hls|hls_?url|hls_?manifest_?url|hlsManifestUrl|dash|dash_?url|mpd|mpd_?url|" +
  "playlist|playlist_?url|manifest|manifest_?url|stream|stream_?url|contentUrl|" +
  "source|src_?hls|fallback_?url|download_?url|media_?url|video_?src|progressive_?url|" +
  "mp4|mp4_?url|master|master_?url|\\d{3,4}p";

// Basa konan geriye bakis, "thumb_url" gibi anahtarlarin sonundaki "url"
// parcasinin yanlislikla eslesmesini engeller.
const PLAYER_KEY_RE = new RegExp(
  `(?<![A-Za-z0-9_])["']?(?:${PLAYER_KEYS})["']?\\s*:\\s*(?:"([^"\\\\]{8,})"|'([^'\\\\]{8,})')`,
  "gi",
);

/** Goreli adreslerde yalnizca medyaya benzeyenleri kabul et (gurultu onleme). */
const RELATIVE_MEDIA_RE =
  /\.(?:m3u8|mpd|mp4|m4v|webm|mkv|m4a|mp3|aac|ogg|opus|wav|flac)(?:[?#]|$)|get_media|get_file|\/hls\/|\/dash\/|\/stream|playlist|manifest|videoplayback/i;

function collectPlayerValue(out: Map<string, Candidate>, base: string, raw?: string) {
  if (!raw) return;
  const value = unescapeAll(raw).trim();
  const absolute = /^(?:https?:)?\/\//.test(value);
  if (!absolute && !(value.startsWith("/") && RELATIVE_MEDIA_RE.test(value))) return;
  collect(out, base, value, "oynatici");
}

/** Sayfa metninden tum medya adaylarini cikarir. */
function extractFromDocument(text: string, base: string, out: Map<string, Candidate>) {
  const decoded = unescapeAll(text);

  for (const tag of text.match(/<meta[^>]+>/gi) || []) {
    const prop = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    if (
      prop === "og:video" ||
      prop === "og:video:url" ||
      prop === "og:video:secure_url" ||
      prop === "og:audio" ||
      prop === "twitter:player:stream" ||
      prop === "video_src"
    ) {
      collect(out, base, attr(tag, "content"), "meta");
    }
  }

  for (const tag of text.match(/<(?:video|audio|source)[^>]*>/gi) || []) {
    collect(out, base, attr(tag, "src"), "html5");
    collect(out, base, attr(tag, "data-src"), "html5");
  }

  for (const tag of text.match(/<link[^>]+>/gi) || []) {
    const type = (attr(tag, "type") || "").toLowerCase();
    if (type.includes("mpegurl") || type.includes("dash+xml")) {
      collect(out, base, attr(tag, "href"), "link");
    }
  }

  for (const block of decoded.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []) {
    for (const m of block.match(/"(?:contentUrl|embedUrl)"\s*:\s*"([^"]+)"/g) || []) {
      collect(out, base, m.split('"')[3], "json-ld");
    }
  }

  // Oynatici yapilandirmalari: bircok site medya adresini isaretlemede degil,
  // JS icindeki bir nesnede tutar. Yaygin anahtarlar ve cagri bicimleri:
  //   JW Player / Video.js : sources: [{ file: "..." }], { src: "..." }
  //   XVideos              : html5player.setVideoUrlHigh('...'), setVideoHLS('...')
  //   Aylo (PornHub ailesi): "mediaDefinitions": [{ "videoUrl": "..." }]
  //   XHamster             : window.initials -> sources.mp4 / sources.hls
  // collect() zaten yalnizca medya uzantisi olanlari kabul ettigi icin bu
  // genis tarama yanlis pozitif uretmez.
  for (const m of decoded.matchAll(PLAYER_KEY_RE)) {
    collectPlayerValue(out, base, m[1] ?? m[2]);
  }

  // sources: ["https://...", "https://..."] bicimindeki diziler.
  for (const block of decoded.matchAll(
    /["']?(?:sources|streams|qualities|formats|files|urls|videos|playlist)["']?\s*:\s*\[([\s\S]{0,6000}?)\]/gi,
  )) {
    for (const value of block[1].matchAll(/["']((?:https?:)?\/\/[^"']{10,})["']/g)) {
      collectPlayerValue(out, base, value[1]);
    }
  }

  for (const m of decoded.matchAll(
    /(?:setVideoUrl\w*|setVideoHLS|setVideoDASH|setVideoDash|loadVideo|playerSource|playSource|setSource|setMedia)\s*\(\s*['"]((?:https?:)?\/\/[^'"]{10,})['"]/gi,
  )) {
    collectPlayerValue(out, base, m[1]);
  }

  for (const m of decoded.match(MEDIA_URL_RE) || []) {
    collect(out, base, m.replace(/[\\",;]+$/, ""), "tarama");
  }
}

/**
 * Uzantisi olmayan adresleri (ornegin YouTube'un imzali videoplayback
 * baglantilari) listeye ekler. Tur ve etiket cagiran tarafindan verilir.
 */
function addCandidate(
  out: Map<string, Candidate>,
  candidate: {
    url: string;
    kind: Kind;
    ext: string;
    label: string;
    key?: string;
    videoOptions?: StreamOption[];
    audioOptions?: StreamOption[];
  },
) {
  const key = candidate.key ?? candidate.url;
  if (!key || out.has(key) || out.size >= MAX_CANDIDATES) return;
  if (candidate.kind !== "pair" && !/^https?:\/\//.test(candidate.url)) return;
  out.set(key, { ...candidate, source: "site-api", rank: 0 });
}


/* ---------------------- uzantisiz adaylarin dogrulanmasi ---------------------- */

const PROBE_TYPES = /^(?:video|audio)\/|mpegurl|dash\+xml|octet-stream|mp2t/i;

/**
 * Uzantisiz adresleri tek baytlik bir istekle yoklar ve icerik turu medya ise
 * listeye ekler. Boylece tokenli / uzantisiz akis adresleri kullanan siteler
 * (ornegin `/get_file/...`, `/master`, imzali CDN uclari) de calisir.
 * En fazla birkac adres denenir, govde indirilmez.
 */
async function probeLooseCandidates(out: Map<string, Candidate>, base: string, cookie?: string) {
  const bag = looseOf(out);
  if (bag.size === 0 || out.size >= MAX_CANDIDATES) return;

  const urls = [...bag.keys()].slice(0, 6);
  await Promise.all(
    urls.map(async (raw) => {
      try {
        const url = await assertSafeUrl(raw);
        const res = await fetch(url, {
          method: "GET",
          headers: {
            ...upstreamHeaders(url, base),
            Range: "bytes=0-1",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(6000),
          dispatcher: await dispatcherFor(url),
        } as RequestInit);
        const type = (res.headers.get("content-type") || "").toLowerCase();
        await res.body?.cancel().catch(() => {});
        if (!res.ok && res.status !== 206) return;
        if (!PROBE_TYPES.test(type)) return;

        const kind: Kind = /mpegurl/.test(type)
          ? "hls"
          : /dash\+xml/.test(type)
            ? "dash"
            : /^audio\//.test(type)
              ? "audio"
              : "video";
        const ext =
          kind === "hls" ? "m3u8" : kind === "dash" ? "mpd" : kind === "audio" ? "m4a" : "mp4";
        const length = Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
        // Onizleme klipleri birkac yuz kilobayt olur; tam video degillerdir.
        if (kind === "video" && length > 0 && length < 200_000) return;
        addCandidate(out, {
          url: res.url || raw,
          key: raw,
          kind,
          ext,
          label: `${labelFor(raw, kind)} (${bag.get(raw) ?? "oynatici"})`,
        });
      } catch {
        /* yoklama basarisiz: aday listeye alinmaz */
      }
    }),
  );
}

/* ------------------------------ JSON yardimcilari ------------------------------ */

/**
 * Metindeki bir konumdan baslayan JSON nesnesini, tirnak icindeki suslu
 * parantezleri sayarak butun halinde keser. Sayfa icindeki
 * `var flashvars_123 = {...};` gibi bloklari almak icin gerekli: duz bir
 * regex ic ice nesnelerde yanlis yerde durur.
 */
function sliceJson(text: string, startIndex: number, open: "{" | "[" = "{"): string | null {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open, startIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = start; i < text.length && i < start + 400_000; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const sliceJsonObject = (text: string, startIndex: number) => sliceJson(text, startIndex, "{");

function parseJsonAt(text: string, marker: RegExp): any | null {
  const m = text.match(marker);
  if (!m || m.index === undefined) return null;
  const raw = sliceJsonObject(text, m.index + m[0].length - 1);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* -------------------------------- YouTube -------------------------------- */

/**
 * YouTube akis adreslerini imzayla korur ve web istemcisinde bunlari cozmek
 * icin oynaticinin JavaScript'ini calistirmak gerekir. Ancak bazi resmi istemci
 * baglamlari (Oculus/VR uygulamasi ve iOS uygulamasi) adresleri imzasiz ve
 * hiz kisitlamasiz doner; asagida bunlar kullaniliyor.
 */
const YT_CLIENTS = [
  {
    id: "5",
    ua: "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
    context: {
      clientName: "IOS",
      clientVersion: "20.03.02",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.2.1.22C161",
      hl: "en",
      gl: "US",
    },
  },
  {
    id: "28",
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip",
    context: {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12",
      hl: "en",
      gl: "US",
    },
  },
];

/** Cozulen ziyaretci kimligi; ayni fonksiyon ornegi icinde yeniden kullanilir. */
let cachedVisitorData: { value: string; expiresAt: number } | null = null;

/**
 * YouTube, kimliksiz isteklere cogu videoda "bot degilsin dogrula" diyor.
 * Gercek bir ziyaretci kimligi (visitorData) sunuldugunda bu kontrol gecilir;
 * kimlik herkese acik service-worker veri ucundan alinir, hesap gerekmez.
 */
async function youtubeVisitorData(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedVisitorData && cachedVisitorData.expiresAt > Date.now()) {
    return cachedVisitorData.value;
  }
  try {
    const { text } = await fetchText(new URL("https://www.youtube.com/sw.js_data"), 5000, {
      referer: "https://www.youtube.com/",
    });
    const cleaned = text.replace(/^\)\]\}'/, "");
    let value: unknown = null;
    try {
      value = JSON.parse(cleaned)?.[0]?.[2]?.[0]?.[0]?.[13];
    } catch {
      /* duz metin uzerinden aranacak */
    }
    if (typeof value !== "string" || value.length < 10) {
      value = cleaned.match(/"(Cg[^"\\]{30,})"/)?.[1] ?? null;
    }
    if (typeof value === "string" && value.length >= 10) {
      cachedVisitorData = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
      return value;
    }
  } catch {
    /* kimlik alinamadi; istek yine de denenir */
  }
  return null;
}

function youtubeId(pageUrl: URL): string | null {
  if (/youtu\.be$/.test(pageUrl.hostname)) {
    return pageUrl.pathname.split("/").filter(Boolean)[0] ?? null;
  }
  const v = pageUrl.searchParams.get("v");
  if (v) return v;
  const m = pageUrl.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function bitrateLabel(bits: number | undefined): string {
  return bits ? `${Math.round(bits / 1000)} kbps` : "";
}

async function youtubeExtract(pageUrl: URL, out: Map<string, Candidate>, cookie?: string) {
  const videoId = youtubeId(pageUrl);
  if (!videoId) return;

  // Isaretlenmis bir ziyaretci kimligi bot kontrolunu tetikleyebilir; ilk tur
  // bos donerse kimlik tazelenip bir kez daha denenir.
  let result = await youtubeAttempt(videoId, out, await youtubeVisitorData(), cookie);
  if (out.size === 0) {
    result = await youtubeAttempt(videoId, out, await youtubeVisitorData(true), cookie);
  }
  if (out.size === 0 && result.reason) throw new Error(result.reason);
  return result.title;
}

async function youtubeAttempt(
  videoId: string,
  out: Map<string, Candidate>,
  visitorData: string | null,
  cookie?: string,
): Promise<{ title: string; reason: string }> {
  let title = "";
  let lastReason = "";

  for (const client of YT_CLIENTS) {
    let data: any;
    try {
      const { text } = await fetchText(
        new URL("https://www.youtube.com/youtubei/v1/player?prettyPrint=false"),
        7000,
        {
          method: "POST",
          cookie,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": client.ua,
            "X-YouTube-Client-Name": client.id,
            "X-YouTube-Client-Version": client.context.clientVersion,
            Origin: "https://www.youtube.com",
            ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
          },
          body: JSON.stringify({
            videoId,
            context: { client: { ...client.context, ...(visitorData ? { visitorData } : {}) } },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );
      data = JSON.parse(text);
    } catch {
      continue;
    }

    const status = data?.playabilityStatus?.status;
    if (status && status !== "OK") {
      lastReason = data?.playabilityStatus?.reason || data?.playabilityStatus?.messages?.[0] || "";
      continue;
    }
    title ||= data?.videoDetails?.title || "";

    const streaming = data?.streamingData ?? {};

    // 1) HLS ana listesi: 144p'den 4K'ya kadar tum kaliteler, video ve ses birlesik.
    if (streaming.hlsManifestUrl) {
      addCandidate(out, {
        url: streaming.hlsManifestUrl,
        kind: "hls",
        ext: "m3u8",
        label: "Tum kaliteler (144p-2160p) - HLS, kalite secilebilir",
      });
    }

    // 2) Tek dosyada video+ses veren klasik bicimler: donusturme gerekmez.
    for (const f of streaming.formats ?? []) {
      if (!f?.url) continue;
      addCandidate(out, {
        url: f.url,
        kind: "video",
        ext: (f.mimeType || "").includes("webm") ? "webm" : "mp4",
        label: `${f.qualityLabel || "video"} - video+ses tek dosya`,
      });
    }

    const adaptive = streaming.adaptiveFormats ?? [];
    const extOfMime = (mime: string) => (String(mime).includes("webm") ? "webm" : "mp4");

    const audios = adaptive
      .filter((f: any) => f?.url && String(f.mimeType || "").startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

    // 3) Ayri video ve ses akislari: en yuksek cozunurlukler yalnizca burada
    //    bulunur. Iki akis istemcide ffmpeg.wasm ile birlestirilir.
    const videos = adaptive
      .filter((f: any) => f?.url && String(f.mimeType || "").startsWith("video/"))
      .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));

    if (videos.length && audios.length) {
      addCandidate(out, {
        key: `pair:${videoId}`,
        url: "",
        kind: "pair",
        ext: "mp4",
        label: `Video + ses birlestir - ${videos[0].qualityLabel || `${videos[0].height}p`} kaliteye kadar`,
        videoOptions: videos.slice(0, 12).map((f: any) => ({
          url: f.url,
          ext: extOfMime(f.mimeType),
          label: `${f.qualityLabel || `${f.height}p`} - ${String(f.mimeType).split(";")[0]} - ${bitrateLabel(f.bitrate)}`,
        })),
        audioOptions: audios.slice(0, 6).map((f: any) => ({
          url: f.url,
          ext: extOfMime(f.mimeType),
          label: `${bitrateLabel(f.bitrate)} - ${String(f.mimeType).split(";")[0]}`,
        })),
      });
    }

    // 4) Yalnizca ses: MP3/M4A isteyenler videoyu hic indirmez.
    if (audios[0]) {
      addCandidate(out, {
        url: audios[0].url,
        kind: "audio",
        ext: extOfMime(audios[0].mimeType) === "webm" ? "webm" : "m4a",
        label: `Yalnizca ses - ${bitrateLabel(audios[0].bitrate)}`,
      });
    }

    if (out.size > 0) break;
  }

  return { title, reason: lastReason };
}

/* ------------------------------- X / Twitter ------------------------------ */

/** Syndication ucu gonderi kimliginden turetilen bir dogrulama belirteci ister. */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function twitterExtract(pageUrl: URL, out: Map<string, Candidate>, cookie?: string) {
  const id = pageUrl.pathname.match(/status(?:es)?\/(\d+)/)?.[1];
  if (!id) return;

  const url = new URL(
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`,
  );
  const { text } = await fetchText(url, 7000, {
    cookie,
    referer: "https://platform.twitter.com/",
    headers: { Accept: "application/json" },
  });
  const data = JSON.parse(text);

  const media = [
    ...(data?.mediaDetails ?? []),
    ...(data?.video ? [data.video] : []),
  ];
  for (const item of media) {
    for (const variant of item?.video_info?.variants ?? item?.variants ?? []) {
      if (!variant?.url) continue;
      const isHls = /mpegurl/i.test(variant.content_type || variant.type || "");
      addCandidate(out, {
        url: variant.url,
        kind: isHls ? "hls" : "video",
        ext: isHls ? "m3u8" : "mp4",
        label: isHls
          ? "Tum kaliteler - HLS, kalite secilebilir"
          : `Video - ${variant.url.match(/\/(\d+x\d+)\//)?.[1] || bitrateLabel(variant.bitrate) || "bilinmeyen kalite"}`,
      });
    }
  }

  const author = data?.user?.screen_name ? `@${data.user.screen_name}` : "";
  const snippet = (data?.text || "").replace(/\s+/g, " ").slice(0, 80);
  return [author, snippet].filter(Boolean).join(" - ");
}

/* ------------------------------- Instagram -------------------------------- */

const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IG_APP_ID = "936619743392459";

/** Kisa kod (shortcode) base64 benzeri bir alfabeyle kodlanmis sayisal kimliktir. */
function instagramMediaId(shortcode: string): string {
  let id = 0n;
  for (const ch of shortcode) {
    const index = IG_ALPHABET.indexOf(ch);
    if (index < 0) return "";
    id = id * 64n + BigInt(index);
  }
  return id.toString();
}

function instagramCollect(node: any, out: Map<string, Candidate>) {
  if (!node || typeof node !== "object") return;

  for (const version of node.video_versions ?? []) {
    if (version?.url) {
      addCandidate(out, {
        url: version.url,
        kind: "video",
        ext: "mp4",
        label: `Video - ${version.width ?? "?"}x${version.height ?? "?"}`,
      });
    }
  }
  if (node.video_url) {
    addCandidate(out, { url: node.video_url, kind: "video", ext: "mp4", label: "Video" });
  }
  // Cok bolumlu gonderilerde her bir ogeyi ayri ayri dolas.
  for (const child of node.carousel_media ?? node.edge_sidecar_to_children?.edges ?? []) {
    instagramCollect(child?.node ?? child, out);
  }
}

async function instagramExtract(pageUrl: URL, out: Map<string, Candidate>, cookie?: string) {
  const shortcode = pageUrl.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (!shortcode) return;
  const mediaId = instagramMediaId(shortcode);

  const headers = {
    "X-IG-App-ID": IG_APP_ID,
    "X-ASBD-ID": "129477",
    "X-IG-WWW-Claim": "0",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
  };
  const referer = `https://www.instagram.com/p/${shortcode}/`;
  let title = "";

  // 1) Resmi web API'si (cerez varsa calisir).
  if (mediaId) {
    try {
      const { text } = await fetchText(
        new URL(`https://www.instagram.com/api/v1/media/${mediaId}/info/`),
        7000,
        { cookie, referer, headers },
      );
      const data = JSON.parse(text);
      for (const item of data?.items ?? []) {
        instagramCollect(item, out);
        title ||= item?.caption?.text?.slice(0, 90) || "";
      }
    } catch {
      /* bir sonraki yontem denenir */
    }
  }

  // 2) GraphQL sorgusu.
  if (out.size === 0) {
    try {
      const { text } = await fetchText(new URL("https://www.instagram.com/graphql/query"), 7000, {
        cookie,
        referer,
        method: "POST",
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          doc_id: "8845758582119845",
          variables: JSON.stringify({ shortcode }),
        }).toString(),
      });
      const data = JSON.parse(text);
      const node = data?.data?.xdt_shortcode_media ?? data?.data?.shortcode_media;
      instagramCollect(node, out);
      title ||= node?.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 90) || "";
    } catch {
      /* bir sonraki yontem denenir */
    }
  }

  // 3) Gomulu oynatici sayfasi (bazi herkese acik gonderilerde yeterli).
  if (out.size === 0) {
    try {
      const { text } = await fetchText(
        new URL(`https://www.instagram.com/p/${shortcode}/embed/captioned/`),
        7000,
        { cookie, referer },
      );
      for (const m of unescapeAll(text).matchAll(/"(?:video_url|src)"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/g)) {
        addCandidate(out, { url: m[1], kind: "video", ext: "mp4", label: "Video" });
      }
    } catch {
      /* son care asagida denenir */
    }
  }

  // 4) Herkese acik embed servisi. Instagram'in kendi uclari oturum istedigi
  //    icin, cerez verilmediginde calisan tek yol budur.
  if (out.size === 0) {
    const url = await instagramViaEmbedService(shortcode);
    if (url) {
      addCandidate(out, { url, kind: "video", ext: "mp4", label: "Video - herkese acik embed servisi" });
    }
  }

  if (out.size === 0) {
    throw new Error(
      cookie
        ? "Instagram cerezi kabul edilmedi ya da gonderi gizli."
        : "Instagram oturum acmadan medya adresi vermiyor.",
    );
  }
  return title || `Instagram ${shortcode}`;
}

/**
 * Sohbet uygulamalarinin Instagram onizlemesi icin kullandigi acik servis,
 * gonderi adresini dogrudan Instagram CDN'indeki dosyaya yonlendirir. Buradan
 * yalnizca yonlendirmedeki adres alinir; video baytlari servisten gecmez.
 *
 * Not: bu adim gonderi kimligini ucuncu bir tarafa gonderir ve yalnizca
 * Instagram'in kendi uclari sonuc vermediginde calisir.
 */
const IG_EMBED_SERVICE = "https://www.kkinstagram.com";

async function instagramViaEmbedService(shortcode: string): Promise<string | null> {
  for (const path of [`videos/${shortcode}/1`, `reel/${shortcode}/`, `p/${shortcode}/`]) {
    try {
      const res = await fetch(`${IG_EMBED_SERVICE}/${path}`, {
        headers: { "User-Agent": "TelegramBot (like TwitterBot)" },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (!location || !/^https:\/\//.test(location)) continue;

      // Fotograf gonderilerinde de yonlendirme gelir; yalnizca videoyu al.
      const head = await fetch(location, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (head && /^video\//i.test(head.headers.get("content-type") || "")) return location;
    } catch {
      /* sonraki yol denenir */
    }
  }
  return null;
}

/* --------------------------------- Reddit --------------------------------- */

/**
 * Reddit'in kendi uclari (API, .json, HTML) veri merkezi IP'lerini reddediyor;
 * bu sunucudan gelen istekler bos bir sayfa aliyor. Ancak medya sunucusu
 * v.redd.it ayni kisiti uygulamiyor: video kimligi bilinirse tum kalitelerin
 * bulundugu HLS ve DASH listeleri dogrudan indirilebiliyor.
 *
 * Kimlik, sohbet uygulamalarinin Reddit onizlemesi icin kullandigi acik bir
 * embed servisinden aliniyor. O servis yalnizca kimligi verir; video baytlari
 * uzerinden gecmez, tarayici dogrudan v.redd.it'ten indirir.
 */
const REDDIT_EMBED_SERVICES = ["https://vxreddit.com", "https://rxddit.com"];

function redditVideoId(text: string): string | null {
  return text.match(/v\.redd\.it(?:%2F|\/)([A-Za-z0-9]{8,})/i)?.[1] ?? null;
}

async function redditExtract(pageUrl: URL, out: Map<string, Candidate>, cookie?: string) {
  let videoId: string | null = null;
  let title = "";

  // 1) Adres zaten dogrudan medya sunucusunu gosteriyor olabilir.
  if (/(^|\.)redd\.it$/.test(pageUrl.hostname)) {
    videoId = pageUrl.pathname.split("/").filter(Boolean)[0] ?? null;
  }

  // 2) Reddit'in kendisi bu sunucuya sonuc verirse oradan al (cerez varsa calisir).
  if (!videoId) {
    try {
      const { text } = await fetchText(pageUrl, 6000, { cookie });
      videoId = redditVideoId(unescapeAll(text));
      title = titleOf(text);
    } catch {
      /* beklenen: veri merkezi IP'si reddedildi */
    }
  }

  // 3) Acik embed servisleri.
  //    Bot kimligi sart: tarayici kimligiyle gelen istegi Reddit'e geri
  //    yonlendiriyorlar, orada da bulut IP'si engelleniyor. Bot kimliginde ise
  //    onizleme icin uretilmis og etiketlerini dogrudan veriyorlar.
  if (!videoId) {
    for (const service of REDDIT_EMBED_SERVICES) {
      try {
        const { text } = await fetchText(new URL(service + pageUrl.pathname), 8000, {
          headers: { "User-Agent": "TelegramBot (like TwitterBot)" },
        });
        const decoded = unescapeAll(text);
        videoId = redditVideoId(decoded);
        title ||= decoded.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? "";
        if (videoId) break;
      } catch {
        /* sonraki servis denenir */
      }
    }
  }

  if (!videoId) {
    throw new Error("Gonderideki video kimligi bulunamadi (Reddit'te barindirilan bir video mu?).");
  }

  // HLS once: ana liste tum kaliteleri ve ayri ses parcasini iceriyor,
  // istemci kaliteyi secip birlestirmeyi kendisi yapiyor.
  addCandidate(out, {
    url: `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`,
    kind: "hls",
    ext: "m3u8",
    label: "Tum kaliteler - HLS, kalite secilebilir",
  });
  addCandidate(out, {
    url: `https://v.redd.it/${videoId}/DASHPlaylist.mpd`,
    kind: "dash",
    ext: "mpd",
    label: "Tum kaliteler - DASH",
  });

  // Reddit'in stub sayfasi genel site basligini veriyor; gonderi adresindeki
  // slug daha aciklayici ve bedava.
  if (!title || /^reddit\b/i.test(title)) {
    const slug = pageUrl.pathname.match(/\/comments\/[a-z0-9]+\/([^/]+)/i)?.[1];
    if (slug) {
      title = decodeURIComponent(slug).replace(/[_+]/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return title;
}

/* ------------------------------ tup motorlari ------------------------------ */

/**
 * Bir JSON nesnesinin icindeki tum medya adreslerini toplar. Oynatici
 * yapilandirmalari (xHamster'in `window.initials`'i gibi) ic ice gecmis
 * nesnelerde adres tuttugu icin duz regex yerine agaci gezmek daha guvenli.
 */
function collectFromJson(
  value: unknown,
  base: string,
  out: Map<string, Candidate>,
  depth = 0,
) {
  if (depth > 8 || out.size >= MAX_CANDIDATES) return;
  if (typeof value === "string") {
    if (/^(?:https?:)?\/\//.test(value.trim())) collect(out, base, value, "site-api");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, base, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectFromJson(item, base, out, depth + 1);
    }
  }
}

/**
 * KVS (Kernel Video Sharing) motoru yuzlerce tup sitesini calistirir. Medya
 * adresi sayfadaki `flashvars` nesnesinde durur, ama `function/0/...` ile
 * baslayan adreslerde yolun bir bolumu karistirilmistir; ayni nesnedeki
 * `license_code` degerinden uretilen bir anahtar dizisiyle geri duzeltilir.
 * Asagidaki iki fonksiyon oynaticinin yaptigi islemin aynisini yapar.
 */
function kvsLicenseToken(licenseCode: string): number[] {
  const code = licenseCode.replace(/\$/g, "");
  const values = [...code].map((c) => Number(c));

  const modified = code.replace(/0/g, "1");
  const center = Math.floor(modified.length / 2);
  const front = Number(modified.slice(0, center + 1));
  const back = Number(modified.slice(center));
  const key = String(4 * Math.abs(front - back)).slice(0, center + 1);

  const token: number[] = [];
  [...key].forEach((char, index) => {
    for (let offset = 0; offset < 4; offset++) {
      token.push((values[index + offset] + Number(char)) % 10);
    }
  });
  return token;
}

function kvsRealUrl(videoUrl: string, licenseCode: string): string {
  if (!videoUrl.startsWith("function/0/")) return videoUrl;
  const rest = videoUrl.slice("function/0/".length);
  if (!licenseCode) return rest;

  let parsed: URL;
  try {
    parsed = new URL(rest);
  } catch {
    return rest;
  }

  const token = kvsLicenseToken(licenseCode);
  const parts = parsed.pathname.split("/");
  const HASH_LENGTH = 32;
  if (parts.length < 4 || parts[3].length < HASH_LENGTH || token.length < HASH_LENGTH) return rest;

  const hash = parts[3].slice(0, HASH_LENGTH);
  const indices = [...Array(HASH_LENGTH).keys()];
  let accum = 0;
  for (let src = HASH_LENGTH - 1; src >= 0; src--) {
    accum += token[src];
    const dest = (src + accum) % HASH_LENGTH;
    [indices[src], indices[dest]] = [indices[dest], indices[src]];
  }
  parts[3] = indices.map((i) => hash[i]).join("") + parts[3].slice(HASH_LENGTH);
  parsed.pathname = parts.join("/");
  return parsed.toString();
}

/** Sayfada KVS oynaticisi varsa tum kalitelerini listeye ekler; basligi doner. */
function kvsExtract(text: string, base: string, out: Map<string, Candidate>): string {
  const start = text.search(/\bflashvars\s*=\s*\{/);
  if (start < 0) return "";
  const raw = sliceJsonObject(text, start);
  if (!raw) return "";
  if (!/\bvideo_(?:alt_)?url\b/.test(raw)) return "";

  const value = (key: string): string =>
    raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']*)["']`))?.[1] ?? "";

  const license = value("license_code");
  const title = decodeEntities(value("video_title"));

  for (const m of raw.matchAll(/["']?(video_(?:alt_)?url\d*)["']?\s*:\s*["']([^"']{6,})["']/g)) {
    const key = m[1];
    const real = absolutize(base, kvsRealUrl(unescapeAll(m[2]).trim(), license));
    if (!real) continue;
    const quality = value(`${key}_text`) || value(`${key}_redirect`) || "";
    const isHls = /\.m3u8(?:[?#]|$)/i.test(real);
    addCandidate(out, {
      url: real,
      kind: isHls ? "hls" : "video",
      ext: isHls ? "m3u8" : extOf(real) || "mp4",
      label: isHls
        ? "HLS akisi - tum kaliteler"
        : `Video - ${quality || "kaynak"} (dogrudan dosya)`,
    });
  }
  return title;
}

/* --------------------------- Aylo (PornHub ailesi) --------------------------- */

/**
 * PornHub, RedTube, YouPorn ve Tube8 ayni altyapiyi kullanir: oynatici
 * yapilandirmasinin `mediaDefinitions` alani tum kalitelerin listesini tutar.
 * Nesnenin adi siteden siteye degistigi icin (PornHub'da `flashvars_<id>`,
 * RedTube'de `page_params.video_player_setup` icinde adsiz) dogrudan
 * `"mediaDefinitions"` dizisi kesilip okunur.
 *
 * Girdilerin bir kismi asil adresi degil, listeyi JSON dondururen bir uc
 * gosterir (`remote: true`, `/media/hls?s=...`, `get_media`); bunlar bir kez
 * daha cagrilir.
 *
 * Yas onayi cerezi olmadan sayfa bos doner; cerez net.mts icinde otomatik
 * ekleniyor.
 */
async function ayloExtract(
  pageUrl: URL,
  out: Map<string, Candidate>,
  cookie?: string,
): Promise<string> {
  const { text, finalUrl } = await fetchText(pageUrl, 9000, { cookie, asPage: true });

  const marker = text.indexOf('"mediaDefinitions"');
  const raw = marker >= 0 ? sliceJson(text, marker, "[") : null;
  let defs: any[] = [];
  if (raw) {
    try {
      defs = JSON.parse(raw);
    } catch {
      /* yapilandirma okunamadi: asagidaki yedege dusulur */
    }
  }

  await Promise.all(defs.map((def) => ayloMediaDefinition(def, finalUrl, out, cookie, 0)));

  // Yedek: yapi degisirse genel tarama devrede kalsin.
  if (out.size === 0) extractFromDocument(text, finalUrl, out);

  const title = text.match(/"video_title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  return (title ? decodeEntities(unescapeAll(title)) : "") || titleOf(text);
}

async function ayloMediaDefinition(
  def: any,
  base: string,
  out: Map<string, Candidate>,
  cookie: string | undefined,
  depth: number,
) {
  const rawUrl = typeof def?.videoUrl === "string" ? def.videoUrl : "";
  if (!rawUrl) return;
  const abs = absolutize(base, unescapeAll(rawUrl));
  if (!abs) return;

  const quality = Array.isArray(def?.quality) ? def.quality.join("/") : def?.quality;
  const direct = /\.(?:m3u8|mp4|m4v|webm)(?:[?#]|$)/i.test(abs);

  // Listeyi JSON dondururen uc: bir kez daha cagrilir.
  if (!direct && depth === 0 && (def?.remote === true || /\/media\/|get_media/i.test(abs))) {
    try {
      const { text } = await fetchText(new URL(abs), 8000, {
        referer: base,
        cookie,
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const items = JSON.parse(text);
      for (const item of Array.isArray(items) ? items : [items]) {
        await ayloMediaDefinition(item, base, out, cookie, depth + 1);
      }
    } catch {
      /* uc cevap vermedi: diger girdiler kullanilir */
    }
    return;
  }
  if (!direct) return;

  const isHls = def?.format === "hls" || /\.m3u8(?:[?#]|$)/i.test(abs);
  addCandidate(out, {
    url: abs,
    kind: isHls ? "hls" : "video",
    ext: isHls ? "m3u8" : extOf(abs) || "mp4",
    label: isHls
      ? `HLS akisi - ${quality ? `${quality}p` : "tum kaliteler"}`
      : `Video - ${quality || "?"}p (dogrudan MP4)`,
  });
}

/* --------------------------------- XHamster -------------------------------- */

/**
 * XHamster medya listesini `window.initials` nesnesinde tutar; icinde hem HLS
 * ana listesi hem de her kalite icin dogrudan MP4 adresleri bulunur.
 */
async function xhamsterExtract(
  pageUrl: URL,
  out: Map<string, Candidate>,
  cookie?: string,
): Promise<string> {
  const { text, finalUrl } = await fetchText(pageUrl, 9000, { cookie, asPage: true });
  const initials = parseJsonAt(text, /window\.initials\s*=\s*\{/);
  const sources = initials?.xplayerSettings?.sources ?? initials?.videoModel?.sources;
  if (sources) collectFromJson(sources, finalUrl, out);
  if (out.size === 0) extractFromDocument(text, finalUrl, out);
  const title = initials?.videoModel?.title ?? initials?.videoEntity?.title;
  return (typeof title === "string" && title) || titleOf(text);
}

/* --------------------------------- Eporner --------------------------------- */

/**
 * Eporner medya adreslerini sayfada tutmaz; oynatici bir XHR ucundan ister ve
 * istege sayfadaki 32 haneli `hash` degerinden turetilen bir anahtar ekler:
 * hash 8'er haneli dort parcaya bolunur, her parca onaltiliktan sayiya
 * cevrilip bastaki sifirlar dusurulerek geri yazilir. Oynaticinin yaptigi
 * islem budur.
 */
async function epornerExtract(
  pageUrl: URL,
  out: Map<string, Candidate>,
  cookie?: string,
): Promise<string> {
  const { text, finalUrl } = await fetchText(pageUrl, 9000, { cookie, asPage: true });
  const id =
    finalUrl.match(/\/video-([A-Za-z0-9]+)/)?.[1] ??
    pageUrl.pathname.match(/\/video-([A-Za-z0-9]+)/)?.[1] ??
    "";
  const hash = text.match(/hash\s*[:=]\s*["']([\da-f]{32})["']/i)?.[1] ?? "";

  let title = "";
  if (id && hash) {
    const key = [0, 8, 16, 24].map((i) => parseInt(hash.slice(i, i + 8), 16).toString(16)).join("");
    const api = new URL(`https://www.eporner.com/xhr/video/${id}`);
    api.search = new URLSearchParams({
      hash: key,
      domain: "www.eporner.com",
      fallback: "false",
      pkey: "",
      sponsored: "",
      videoid: id,
    }).toString();

    try {
      const { text: json } = await fetchText(api, 8000, {
        referer: finalUrl,
        cookie,
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const data = JSON.parse(json);
      title = typeof data?.title === "string" ? data.title : "";
      for (const [format, entries] of Object.entries(data?.sources ?? {})) {
        for (const [quality, item] of Object.entries((entries ?? {}) as Record<string, any>)) {
          const src = typeof item?.src === "string" ? item.src : "";
          const abs = src ? absolutize(finalUrl, unescapeAll(src)) : null;
          // Uc, video kullanilamadiginda yer tutucu bir klip donduruyor.
          if (!abs || /\/na\.mp4(?:[?#]|$)/i.test(abs)) continue;
          const isHls = /hls/i.test(format) || /\.m3u8(?:[?#]|$)/i.test(abs);
          addCandidate(out, {
            url: abs,
            kind: isHls ? "hls" : "video",
            ext: isHls ? "m3u8" : extOf(abs) || "mp4",
            label: isHls ? `HLS akisi - ${quality}` : `Video - ${quality} (dogrudan MP4)`,
          });
        }
      }
    } catch {
      /* uc cevap vermedi: genel tarama devreye girer */
    }
  }

  // Uc her zaman calismiyor; sayfadaki isaretleme de taranir.
  extractFromDocument(text, finalUrl, out);
  return title || titleOf(text);
}

/* -------------------------------- SpankBang -------------------------------- */

/**
 * SpankBang kaliteleri `stream_data` adli bir JS nesnesinde, kalite adiyla
 * anahtarlanmis diziler halinde tutar (JSON degil, tek tirnakli JS).
 */
async function spankbangExtract(
  pageUrl: URL,
  out: Map<string, Candidate>,
  cookie?: string,
): Promise<string> {
  const { text, finalUrl } = await fetchText(pageUrl, 9000, { cookie, asPage: true });
  const start = text.search(/stream_data\s*=\s*\{/);
  const raw = start >= 0 ? sliceJsonObject(text, start) : null;
  if (raw) {
    for (const group of raw.matchAll(/["']?(\w+)["']?\s*:\s*\[([^\]]*)\]/g)) {
      const quality = group[1];
      for (const value of group[2].matchAll(/["']((?:https?:)?\/\/[^"']{10,})["']/g)) {
        const abs = absolutize(finalUrl, unescapeAll(value[1]));
        if (!abs) continue;
        const isHls = /\.m3u8(?:[?#]|$)/i.test(abs);
        addCandidate(out, {
          url: abs,
          kind: isHls ? "hls" : "video",
          ext: isHls ? "m3u8" : extOf(abs) || "mp4",
          label: isHls ? "HLS akisi - tum kaliteler" : `Video - ${quality}`,
        });
      }
    }
  }
  if (out.size === 0) extractFromDocument(text, finalUrl, out);
  return titleOf(text);
}

/* ----------------------- siteye ozel cozumleyiciler ----------------------- */

/**
 * Bazi platformlar medya adresini HTML'e hic koymaz; herkese acik oynatici
 * uclarindan alinmasi gerekir. Basarisiz olurlarsa genel tarama zaten devrede.
 */
const SITE_HELPERS: Array<{
  match: RegExp;
  run: (pageUrl: URL, out: Map<string, Candidate>, cookie?: string) => Promise<string | void>;
  /** true ise yardimci sonuc verdiginde sayfa HTML'i hic indirilmez. */
  authoritative?: boolean;
}> = [
  {
    // YouTube: InnerTube oynatici ucu, imza cozumu gerektirmeyen istemcilerle.
    match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => youtubeExtract(pageUrl, out, cookie),
  },
  {
    // X / Twitter: herkese acik syndication ucu.
    match: /(^|\.)x\.com$|(^|\.)twitter\.com$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => twitterExtract(pageUrl, out, cookie),
  },
  {
    // Instagram: anonim erisim kapali, kullanicinin kendi cerezi gerekir.
    match: /(^|\.)instagram\.com$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => instagramExtract(pageUrl, out, cookie),
  },
  {
    // Vimeo: oynatici yapilandirmasi HLS ve dogrudan mp4 adreslerini verir.
    match: /(^|\.)vimeo\.com$/,
    run: async (pageUrl, out, cookie) => {
      const id = pageUrl.pathname.match(/(\d{6,})/)?.[1];
      if (!id) return;
      const configUrl = new URL(`https://player.vimeo.com/video/${id}/config`);
      const { text } = await fetchText(configUrl, 5000, { referer: "https://vimeo.com/", cookie });
      const config = JSON.parse(text);
      const files = config?.request?.files ?? {};

      for (const item of files.progressive ?? []) {
        if (item?.url) {
          collect(out, configUrl.toString(), item.url, "site-api",
            `Video - ${item.quality || `${item.height || "?"}p`} (dogrudan MP4)`);
        }
      }
      for (const kind of ["hls", "dash"] as const) {
        const cdns = files[kind]?.cdns ?? {};
        const preferred = files[kind]?.default_cdn;
        const entry = cdns[preferred] ?? Object.values(cdns)[0];
        const url = (entry as any)?.avc_url ?? (entry as any)?.url;
        if (url) {
          collect(out, configUrl.toString(), url, "site-api",
            kind === "hls" ? "HLS akisi - tum kaliteler" : "DASH akisi - tum kaliteler");
        }
      }
      return config?.video?.title;
    },
  },
  {
    // Dailymotion: oynatici ust verisi qualities altinda adresleri listeler.
    match: /(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/,
    run: async (pageUrl, out, cookie) => {
      const id = pageUrl.pathname.match(/(?:video\/)?([a-z0-9]{5,})\/?$/i)?.[1];
      if (!id) return;
      const metaUrl = new URL(`https://www.dailymotion.com/player/metadata/video/${id}`);
      const { text } = await fetchText(metaUrl, 5000, { referer: pageUrl.toString(), cookie });
      const meta = JSON.parse(text);
      for (const [quality, items] of Object.entries(meta?.qualities ?? {})) {
        for (const item of (items as Array<{ url?: string; type?: string }>) ?? []) {
          if (!item?.url) continue;
          const isHls = /mpegurl/i.test(item.type ?? "") || item.url.includes(".m3u8");
          collect(out, metaUrl.toString(), item.url, "site-api",
            isHls ? "HLS akisi - tum kaliteler" : `Video - ${quality}p`);
        }
      }
      return meta?.title;
    },
  },
  {
    // Reddit: veri merkezi IP'lerini reddediyor, ama medya sunucusu acik.
    match: /(^|\.)reddit\.com$|(^|\.)redd\.it$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => redditExtract(pageUrl, out, cookie),
  },
  {
    // Aylo ailesi: medya listesi flashvars -> mediaDefinitions icinde.
    match: /(^|\.)pornhub(premium)?\.(com|org|net)$|(^|\.)(redtube|youporn|tube8|thumbzilla)\.com$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => ayloExtract(pageUrl, out, cookie),
  },
  {
    // XHamster: window.initials -> xplayerSettings.sources
    match: /(^|\.)xhamster\w*\.(com|desi|one)$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => xhamsterExtract(pageUrl, out, cookie),
  },
  {
    // SpankBang: stream_data nesnesi.
    match: /(^|\.)spankbang\.(com|party)$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => spankbangExtract(pageUrl, out, cookie),
  },
  {
    // Eporner: adresler yalnizca imzali XHR ucundan geliyor.
    match: /(^|\.)eporner\.com$/,
    authoritative: true,
    run: (pageUrl, out, cookie) => epornerExtract(pageUrl, out, cookie),
  },
];

async function runSiteHelper(
  pageUrl: URL,
  out: Map<string, Candidate>,
  cookie?: string,
): Promise<{ title: string; authoritative: boolean }> {
  const helper = SITE_HELPERS.find((h) => h.match.test(pageUrl.hostname));
  if (!helper) return { title: "", authoritative: false };
  const title = (await helper.run(pageUrl, out, cookie)) || "";
  return { title, authoritative: Boolean(helper.authoritative) && out.size > 0 };
}

/**
 * Yas kapisi sayfalarinin ortak izleri. Sayfada medya bulunamadiginda, sayfayi
 * onay cerezleriyle yeniden istemeye deger mi diye bakilir.
 */
const AGE_WALL_RE =
  /18\s*(?:\+|yas|years?)|age[-_ ]?(?:verification|verify|gate|check|confirm)|yas(?:ini|inizi)?\s*dogrula|adults?\s*only|enter\s*(?:site|here)|i\s*am\s*(?:over\s*)?18|parental\s*consent|yetiskin\s*icerik/i;

function titleOf(html: string): string {
  const og = html.match(/<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]*>/i);
  if (og) {
    const c = attr(og[0], "content");
    if (c) return decodeEntities(c).trim();
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function posterOf(html: string, base: string): string {
  const og = html.match(/<meta[^>]+(?:property|name)\s*=\s*["']og:image(?::secure_url)?["'][^>]*>/i);
  if (!og) return "";
  const c = attr(og[0], "content");
  return c ? absolutize(base, c) || "" : "";
}

/** Sonuca gore kullaniciya gosterilecek aciklama. */
function noteFor(host: string, found: number, helperError: string, hasCookie: boolean): string {
  const h = host.replace(/^www\./, "");

  if (/instagram\.com$/.test(h) && found === 0) {
    return hasCookie
      ? "Instagram cerezi ise yaramadi: suresi dolmus olabilir ya da gonderi gizli bir hesaba ait."
      : "Gonderiye ulasilamadi. Gizli hesaplar ve videosuz gonderiler icin sonuc donmez; gizli bir gonderiyse gelismis ayarlardan kendi Instagram cerezini kullanabilirsin.";
  }
  if (/youtube\.com$|youtu\.be$/.test(h) && found === 0 && /bot|sign in/i.test(helperError)) {
    return hasCookie
      ? "YouTube cerezi kabul edilmedi. Cerezin suresi dolmus olabilir; tarayicindan yeniden kopyala."
      : "YouTube bu sunucunun IP adresini bot olarak isaretledi. Gelismis ayarlardan kendi YouTube cerezini yapistirirsan istek senin hesabin adina yapilir ve bu kontrol asilir.";
  }
  if (found === 0 && helperError) {
    return `Site su yaniti verdi: ${helperError.slice(0, 160)}`;
  }
  if (/youtube\.com$|youtu\.be$/.test(h) && found > 0) {
    return "En yuksek kalite icin HLS veya 'Video + ses birlestir' secenegini kullan; tek dosyalik bicimler 360p ile sinirlidir.";
  }
  if (/(^|\.)x\.com$|twitter\.com$/.test(h) && found === 0) {
    return "Gonderide video bulunamadi. Yas siniri olan veya korumali hesaplardaki gonderiler icin cerez gerekir.";
  }
  if (/facebook\.com$/.test(h) && found === 0) {
    return "Facebook cogu gonderi icin oturum ister; gelismis ayarlardan cerez ekleyebilirsin.";
  }
  if (/tiktok\.com$/.test(h)) {
    return "TikTok adresleri kisa omurludur; bulunursa hemen indirin.";
  }
  if (found === 0) {
    return (
      "Sayfada oynatilabilir bir medya adresi bulunamadi. Sik gorulen nedenler: " +
      "video yalnizca giris yapmis kullanicilara aciktir (gelismis ayarlardan kendi " +
      "cerezini yapistirabilirsin), sayfa videoyu JavaScript calistiktan sonra yukler, " +
      "ya da adres video sayfasi degil bir liste/profil sayfasidir."
    );
  }
  return "";
}

export default async (req: Request, _context: Context) => {
  const params = new URL(req.url).searchParams;
  const target = params.get("url");
  if (!target) return jsonResponse({ error: "url parametresi gerekli." }, 400);

  let pageUrl: URL;
  try {
    pageUrl = await assertSafeUrl(target);
  } catch (err) {
    const e = err as HttpError;
    return jsonResponse({ error: e.message }, e.status ?? 400);
  }

  // Kullanici kendi oturum cerezini verebilir (Instagram gibi siteler icin).
  // Cerez hicbir yerde saklanmaz, yalnizca hedef siteye iletilir.
  const cookie = req.headers.get("x-site-cookie") || undefined;

  const out = new Map<string, Candidate>();

  // 1) Adresin kendisi zaten bir medya dosyasi olabilir.
  const directExt = extOf(pageUrl.toString());
  if (new RegExp(`^(?:${MEDIA_EXT})$`).test(directExt) && directExt !== "ts") {
    collect(out, pageUrl.toString(), pageUrl.toString(), "dogrudan");
    return jsonResponse({
      pageUrl: pageUrl.toString(),
      title: decodeURIComponent(pageUrl.pathname.split("/").pop() || "medya"),
      poster: "",
      note: "",
      candidates: [...out.values()],
    });
  }

  // 2) Siteye ozel oynatici uclari. YouTube, X ve Instagram medya adresini
  //    sayfa HTML'ine hic koymaz; bu platformlarda tek calisan yol budur.
  let helperError = "";
  let helper: { title: string; authoritative: boolean } = { title: "", authoritative: false };
  try {
    helper = await runSiteHelper(pageUrl, out, cookie);
  } catch (err) {
    helperError = (err as Error).message;
  }

  let html = "";
  let finalUrl = pageUrl.toString();
  let contentType = "";
  let kvsTitle = "";

  /** Bir belgeden hem genel hem KVS motoru adaylarini toplar. */
  const harvest = (text: string, base: string) => {
    // KVS once calisir: ayni adresi genel tarama da bulabilir, ama oradan
    // gelen kayit daha dusuk guvenle isaretlenir ve listede geriye duser.
    kvsTitle ||= kvsExtract(text, base, out);
    extractFromDocument(text, base, out);
  };

  // Yardimci kesin sonuc verdiyse sayfayi ayrica indirmeye gerek yok.
  if (!helper.authoritative) {
    try {
      const res = await fetchText(pageUrl, 7000, { cookie, asPage: true });
      html = res.text;
      finalUrl = res.finalUrl;
      contentType = res.type;
    } catch (err) {
      if (out.size === 0) {
        return jsonResponse({ error: `Sayfa okunamadi: ${(err as Error).message}` }, 502);
      }
    }

    // 3) Sunucu HTML degil de dogrudan medya dondurduyse.
    if (/^(video|audio)\//i.test(contentType) || /mpegurl|dash\+xml/i.test(contentType)) {
      collect(out, finalUrl, finalUrl, "content-type");
    }

    harvest(html, finalUrl);

    // 3b) Yas kapisi: sayfa medyasiz dondu ve icerigi "18 yasindan buyuk
    //     musun" sorusuna benziyorsa onay cerezleriyle bir kez daha dene.
    //     Bilinen sitelerde cerez zaten otomatik gidiyor; bu adim listede
    //     olmayan siteler icin.
    if (out.size === 0 && AGE_WALL_RE.test(html)) {
      try {
        const res = await fetchText(pageUrl, 7000, {
          cookie: mergeCookies(GENERIC_AGE_COOKIE, cookie),
          asPage: true,
          referer: finalUrl,
        });
        if (res.text && res.text !== html) {
          html = res.text;
          finalUrl = res.finalUrl;
          harvest(html, finalUrl);
        }
      } catch {
        /* ikinci deneme de olmadi: asagidaki adimlar surer */
      }
    }
  }

  const confidentCount = () => [...out.values()].filter((c) => c.rank < 3).length;

  // 4) Guvenilir aday yoksa gomulu oynaticilari (iframe) bir seviye takip et.
  //    Eskiden yalnizca hic aday yokken calisiyordu; oysa bircok sitede
  //    sayfada sadece onizleme klibi vardir, asil video iframe icindedir.
  if (confidentCount() === 0 && html) {
    const frames: string[] = [];
    for (const tag of html.match(/<iframe[^>]*>/gi) || []) {
      const src = attr(tag, "src") || attr(tag, "data-src") || attr(tag, "data-litespeed-src");
      const abs = src ? absolutize(finalUrl, src) : null;
      if (
        abs &&
        !/(google|doubleclick|facebook\.com\/plugins|disqus|recaptcha|adservice|twitter\.com\/widgets)/i.test(
          abs,
        )
      ) {
        frames.push(abs);
      }
      if (frames.length >= 4) break;
    }
    await Promise.all(
      frames.map(async (frame) => {
        try {
          const safeFrame = await assertSafeUrl(frame);
          const res = await fetchText(safeFrame, 5000, { referer: finalUrl, cookie, asPage: true });
          harvest(res.text, res.finalUrl);
        } catch {
          /* gomulu oynatici okunamadi */
        }
      }),
    );
  }

  // 5) Hala guvenilir aday yoksa, uzantisi olmadigi icin elenen adresleri
  //    icerik turune bakarak dogrula: tokenli ve uzantisiz akis adresleri
  //    kullanan siteler ancak boyle cozulur.
  if (confidentCount() === 0) {
    await probeLooseCandidates(out, finalUrl, cookie);
  }

  const kindRank = (c: Candidate) =>
    c.kind === "hls" ? 0 : c.kind === "pair" ? 1 : c.kind === "dash" ? 2 : c.kind === "video" ? 3 : 4;

  // Ham metin taramasi (rank 3) son caredir: isaretlemeden ya da oynatici
  // yapilandirmasindan gelen bir sonuc varsa, tarama sonuclari cogunlukla
  // gurultu olur (oneri kutularindaki baska videolar). Gene de akis listeleri
  // (m3u8 / mpd) bu kurala girmez: onlar asla onizleme klibi olmaz ve pek cok
  // sitede asil kaynak yalnizca taramada goruluyor. Bu yuzden taramadan gelen
  // akislar her zaman listede kalir, yalnizca tekil dosyalar elenir.
  const all = [...out.values()];
  const confident = all.filter((c) => c.rank < 3);
  const scannedStreams = all.filter(
    (c) => c.rank >= 3 && (c.kind === "hls" || c.kind === "dash"),
  );
  /** Etiket ya da adresten okunabilen dikey cozunurluk (yoksa 0). */
  const heightOf = (c: Candidate) => {
    const m = `${c.label} ${c.url}`.match(/(\d{3,4})\s*[pP]\b|\b(2160|1440|1080|720|480|360|240)\b/);
    return Number(m?.[1] ?? m?.[2] ?? 0);
  };
  const candidates = (confident.length ? [...confident, ...scannedStreams] : all).sort(
    (a, b) => kindRank(a) - kindRank(b) || a.rank - b.rank || heightOf(b) - heightOf(a),
  );

  return jsonResponse({
    pageUrl: finalUrl,
    title: helper.title || kvsTitle || titleOf(html) || pageUrl.hostname,
    poster: posterOf(html, finalUrl),
    note: noteFor(pageUrl.hostname, candidates.length, helperError, Boolean(cookie)),
    candidates,
  });
};

export const config: Config = {
  path: "/api/resolve",
};
