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

type Kind = "hls" | "dash" | "video" | "audio";

interface Candidate {
  url: string;
  kind: Kind;
  label: string;
  source: string;
  ext: string;
  rank: number;
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

async function fetchText(url: URL, timeoutMs: number, referer?: string) {
  const res = await fetch(url, {
    headers: upstreamHeaders(url, referer),
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

/* ----------------------- siteye ozel cozumleyiciler ----------------------- */

/**
 * Bazi platformlar medya adresini HTML'e hic koymaz; herkese acik oynatici
 * uclarindan alinmasi gerekir. Basarisiz olurlarsa genel tarama zaten devrede.
 */
const SITE_HELPERS: Array<{
  match: RegExp;
  run: (pageUrl: URL, out: Map<string, Candidate>) => Promise<string | void>;
}> = [
  {
    // Vimeo: oynatici yapilandirmasi HLS ve dogrudan mp4 adreslerini verir.
    match: /(^|\.)vimeo\.com$/,
    run: async (pageUrl, out) => {
      const id = pageUrl.pathname.match(/(\d{6,})/)?.[1];
      if (!id) return;
      const configUrl = new URL(`https://player.vimeo.com/video/${id}/config`);
      const { text } = await fetchText(configUrl, 5000, "https://vimeo.com/");
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
      const { text } = await fetchText(metaUrl, 5000, pageUrl.toString());
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
      const { text } = await fetchText(jsonUrl, 5000);
      extractFromDocument(text, jsonUrl.toString(), out);
    },
  },
];

async function runSiteHelper(pageUrl: URL, out: Map<string, Candidate>): Promise<string> {
  const helper = SITE_HELPERS.find((h) => h.match.test(pageUrl.hostname));
  if (!helper) return "";
  try {
    return (await helper.run(pageUrl, out)) || "";
  } catch {
    return ""; // yardimci basarisizsa genel tarama devam eder
  }
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

function noteFor(host: string): string {
  const h = host.replace(/^www\./, "");
  if (/youtube\.com$|youtu\.be$/.test(h)) {
    return "YouTube akislarini imzali URL ile korur; tarayici tarafindan cozulemez. Bu site YouTube icin calismaz.";
  }
  if (/instagram\.com$|facebook\.com$/.test(h)) {
    return "Meta siteleri genellikle oturum cerezi ister; herkese acik gonderiler disinda sonuc bulunamayabilir.";
  }
  if (/(^|\.)x\.com$|twitter\.com$/.test(h)) {
    return "X/Twitter medya adresleri misafir tokeni ister; her gonderide sonuc alinamayabilir.";
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

  let html = "";
  let finalUrl = pageUrl.toString();
  let contentType = "";
  try {
    const res = await fetchText(pageUrl, 7000);
    html = res.text;
    finalUrl = res.finalUrl;
    contentType = res.type;
  } catch (err) {
    return jsonResponse(
      { error: `Sayfa okunamadi: ${(err as Error).message}` },
      502,
    );
  }

  // 2) Sunucu HTML degil de dogrudan medya dondurduyse.
  if (/^(video|audio)\//i.test(contentType) || /mpegurl|dash\+xml/i.test(contentType)) {
    collect(out, finalUrl, finalUrl, "content-type");
  }

  extractFromDocument(html, finalUrl, out);

  // 3) Siteye ozel oynatici uclari (HTML'de adres bulunmayan platformlar icin).
  const helperTitle = await runSiteHelper(pageUrl, out);

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
          const res = await fetchText(safeFrame, 4000, finalUrl);
          extractFromDocument(res.text, res.finalUrl, out);
        } catch {
          /* gomulu oynatici okunamadi */
        }
      }),
    );
  }

  const kindRank = (c: Candidate) =>
    c.kind === "hls" ? 0 : c.kind === "dash" ? 1 : c.kind === "video" ? 2 : 3;
  const candidates = [...out.values()].sort(
    (a, b) => a.rank - b.rank || kindRank(a) - kindRank(b),
  );

  return jsonResponse({
    pageUrl: finalUrl,
    title: helperTitle || titleOf(html) || pageUrl.hostname,
    poster: posterOf(html, finalUrl),
    note: noteFor(pageUrl.hostname),
    candidates,
  });
};

export const config: Config = {
  path: "/api/resolve",
};
