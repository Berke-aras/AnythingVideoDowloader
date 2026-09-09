/**
 * /api/resolve — sayfadaki medya adaylarini bulur.
 *
 * Sadece HTML/JSON metnini okur ve icindeki medya adreslerini cikarir; video
 * byte'larina hic dokunmaz. Boylece sunucu tarafi hem hizli hem de ucuz kalir,
 * asil yuk (indirme + birlestirme + donusturme) istemciye birakilir.
 */

import type { Config, Context } from "@netlify/functions";
import { assertSafeUrl, HttpError, jsonResponse, upstreamHeaders } from "../lib/net.mjs";

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
  tarama: 3,
};

function extOf(u: string): string {
  const clean = u.split("#")[0].split("?")[0];
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
}

async function fetchText(url: URL, timeoutMs: number, options: FetchOptions = {}) {
  const headers: Record<string, string> = {
    ...upstreamHeaders(url, options.referer),
    ...(options.headers ?? {}),
  };
  if (options.cookie) headers.Cookie = options.cookie;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body,
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  if (!new RegExp(`^(?:${MEDIA_EXT})$`).test(ext)) return;
  if (ext === "ts") return; // tek segment; tam video degil
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
      /* umit kesildi; cagiran taraf aciklayici not gosterecek */
    }
  }

  if (out.size === 0) {
    throw new Error(
      cookie
        ? "Instagram cerezi kabul edilmedi ya da gonderi gizli."
        : "Instagram oturum acmadan medya adresi vermiyor.",
    );
  }
  return title;
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
    run: async (pageUrl, out) => {
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
    run: async (pageUrl, out) => {
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
    // Reddit medya adresini yalnizca JSON ucunda verir.
    match: /(^|\.)reddit\.com$/,
    run: async (pageUrl, out) => {
      const jsonUrl = new URL(pageUrl.toString().split("?")[0].replace(/\/$/, "") + ".json");
      const { text } = await fetchText(jsonUrl, 5000, { cookie });
      extractFromDocument(text, jsonUrl.toString(), out);
    },
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
      : "Instagram, oturum acmayan istemcilere medya adresi vermiyor. Gelismis ayarlardan kendi Instagram cerezini yapistirirsan bu gonderi indirilebilir.";
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

  // Yardimci kesin sonuc verdiyse sayfayi ayrica indirmeye gerek yok.
  if (!helper.authoritative) {
    try {
      const res = await fetchText(pageUrl, 7000, { cookie });
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

    extractFromDocument(html, finalUrl, out);
  }

  // 4) Hala bos ise gomulu oynaticilari (iframe) bir seviye takip et.
  if (out.size === 0) {
    const frames: string[] = [];
    for (const tag of html.match(/<iframe[^>]*>/gi) || []) {
      const src = attr(tag, "src") || attr(tag, "data-src");
      const abs = src ? absolutize(finalUrl, src) : null;
      if (abs && !/(google|doubleclick|facebook\.com\/plugins|disqus)/i.test(abs)) frames.push(abs);
      if (frames.length >= 3) break;
    }
    await Promise.all(
      frames.map(async (frame) => {
        try {
          const safeFrame = await assertSafeUrl(frame);
          const res = await fetchText(safeFrame, 4000, { referer: finalUrl, cookie });
          extractFromDocument(res.text, res.finalUrl, out);
        } catch {
          /* gomulu oynatici okunamadi */
        }
      }),
    );
  }

  const kindRank = (c: Candidate) =>
    c.kind === "hls" ? 0 : c.kind === "pair" ? 1 : c.kind === "dash" ? 2 : c.kind === "video" ? 3 : 4;
  const candidates = [...out.values()].sort(
    (a, b) => a.rank - b.rank || kindRank(a) - kindRank(b),
  );

  return jsonResponse({
    pageUrl: finalUrl,
    title: helper.title || titleOf(html) || pageUrl.hostname,
    poster: posterOf(html, finalUrl),
    note: noteFor(pageUrl.hostname, candidates.length, helperError, Boolean(cookie)),
    candidates,
  });
};

export const config: Config = {
  path: "/api/resolve",
};
