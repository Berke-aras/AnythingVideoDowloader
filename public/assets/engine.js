/**
 * Indirme motoru — tamami tarayicida calisir.
 *
 * Sunucu yalnizca CORS aktarici olarak kullanilir; parcalarin indirilmesi,
 * AES cozumu, HLS/DASH birlestirmesi ve bellek yonetimi kullanicinin
 * makinesinde yapilir.
 */

const CHUNK_SIZE = 4 * 1024 * 1024; // Netlify fonksiyon suresi icinde rahatca biten boyut
const CHUNK_CONCURRENCY = 4;
const SEGMENT_CONCURRENCY = 6;

// Gecici sunucu hatalari: paralel istek atan siteler siklikla 429 dondurur.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

export function proxied(url, ref) {
  const q = new URLSearchParams({ url });
  if (ref) q.set("ref", ref);
  return `/api/proxy?${q}`;
}

// Kullanicinin verdigi oturum cerezi. Yalnizca istek basliginda tasinir ve
// sunucu tarafinda hedef siteye iletilir; hicbir yerde saklanmaz.
let siteCookie = "";

export function setSiteCookie(value) {
  siteCookie = value || "";
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Iptal edildi", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Proxy uzerinden istek atar; gecici hatalarda ustel geri cekilme ile yeniden dener.
 * Kalici hatalar (404, 403 gibi) oldugu gibi dondurulur, karar cagirana birakilir.
 */
async function httpGet(url, { ref, headers, signal } = {}) {
  let lastError = null;
  let retryAfterMs = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.random() * 300;
      await sleep(Math.max(retryAfterMs, backoff), signal);
    }
    try {
      const res = await fetch(proxied(url, ref), {
        headers: { ...headers, ...(siteCookie ? { "X-Site-Cookie": siteCookie } : {}) },
        signal,
      });
      if (!RETRY_STATUS.has(res.status)) return res;

      await res.body?.cancel().catch(() => {});
      const retryAfter = Number(res.headers.get("retry-after"));
      retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      lastError = new Error(`Sunucu gecici olarak reddetti (${res.status})`);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("Istek basarisiz oldu.");
}

/** Sinirli es zamanlilikla is havuzu calistirir. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function concatChunks(parts, totalLength) {
  const total = totalLength ?? parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function fetchText(url, ref, signal) {
  const res = await httpGet(url, { ref, signal });
  if (!res.ok) throw new Error(`${res.status} — kaynak okunamadi`);
  return res.text();
}

/**
 * Dosya boyutunu ve Range destegini olcer.
 *
 * Tek baytlik bir Range istegi kullanilir: 206 yaniti hem aralik destegini
 * kanitlar hem de Content-Range basliginda toplam boyutu verir. HEAD'e
 * guvenilmez, cunku araya giren CDN'ler govdesiz yanitlarda Content-Length'i
 * kaldirabiliyor.
 */
async function probe(url, ref, signal) {
  try {
    const res = await httpGet(url, { ref, headers: { Range: "bytes=0-0" }, signal });
    const type = res.headers.get("content-type") || "";

    if (res.status === 206) {
      const total = Number((res.headers.get("content-range") || "").split("/")[1]);
      await res.body?.cancel().catch(() => {});
      if (Number.isFinite(total) && total > 0) return { size: total, ranges: true, type };
      return { size: 0, ranges: false, type };
    }

    // 206 gelmediyse sunucu araligi yok saydi: tum govdeyi gondermistir.
    await res.body?.cancel().catch(() => {});
    const size = Number(res.headers.get("x-upstream-length") || res.headers.get("content-length") || 0);
    return { size: res.ok ? size : 0, ranges: false, type };
  } catch {
    return { size: 0, ranges: false, type: "" };
  }
}

/**
 * Tek bir dosyayi indirir. Sunucu Range destekliyorse dosya parcalara bolunup
 * paralel cekilir; bu hem daha hizlidir hem de her istegi kisa tutar.
 */
export async function downloadFile(url, { ref, onProgress, signal } = {}) {
  const info = await probe(url, ref, signal);

  if (info.size > CHUNK_SIZE && info.ranges) {
    try {
      const ranges = [];
      for (let start = 0; start < info.size; start += CHUNK_SIZE) {
        ranges.push([start, Math.min(start + CHUNK_SIZE, info.size) - 1]);
      }
      let done = 0;
      const parts = await pool(ranges, CHUNK_CONCURRENCY, async ([start, end]) => {
        const res = await httpGet(url, { ref, signal, headers: { Range: `bytes=${start}-${end}` } });
        if (!res.ok && res.status !== 206) throw new Error(`Parca indirilemedi (${res.status})`);
        const buf = new Uint8Array(await res.arrayBuffer());
        done += buf.byteLength;
        onProgress?.(done, info.size);
        return buf;
      });
      return concatChunks(parts, info.size);
    } catch (err) {
      // Bazi sunucular es zamanli istekleri sinirlar. Yeniden denemeler de
      // yetmediyse tek baglantiyla, bastan indirmeyi dene.
      if (err.name === "AbortError") throw err;
      onProgress?.(0, info.size);
    }
  }

  const res = await httpGet(url, { ref, signal });
  if (!res.ok) throw new Error(`Indirme basarisiz (${res.status})`);
  const total = Number(res.headers.get("content-length") || info.size || 0);
  const reader = res.body.getReader();
  const parts = [];
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    parts.push(value);
    done += value.byteLength;
    onProgress?.(done, total);
  }
  return concatChunks(parts, done);
}

/* ------------------------------------------------------------------ */
/* HLS                                                                 */
/* ------------------------------------------------------------------ */

function absolute(base, u) {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  return attrs;
}

/** M3U8 metnini ana liste (variant) veya segment listesi olarak coz. */
export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const segments = [];
  const audioGroups = {};
  let key = null;
  let map = null;
  let pending = null;
  let sequence = 0;
  let duration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttributes(line.slice(18));
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) {
        (audioGroups[a["GROUP-ID"]] ||= []).push({
          url: absolute(baseUrl, a.URI),
          name: a.NAME || a.LANGUAGE || "ses",
          language: a.LANGUAGE || "",
          isDefault: a.DEFAULT === "YES",
        });
      }
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(11));
      key = a.METHOD && a.METHOD !== "NONE" ? { method: a.METHOD, uri: absolute(baseUrl, a.URI), iv: a.IV } : null;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) map = { url: absolute(baseUrl, a.URI), byterange: a.BYTERANGE };
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;

    const url = absolute(baseUrl, line);
    if (pending) {
      const [w, h] = (pending.RESOLUTION || "x").split("x");
      variants.push({
        url,
        bandwidth: Number(pending.BANDWIDTH || 0),
        width: Number(w) || 0,
        height: Number(h) || 0,
        codecs: pending.CODECS || "",
        audioGroup: pending.AUDIO || "",
      });
      pending = null;
    } else {
      segments.push({ url, key, duration, index: sequence + segments.length });
      duration = 0;
    }
  }

  return {
    isMaster: variants.length > 0,
    variants: variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth)),
    audioGroups,
    segments,
    map,
  };
}

async function importKey(uri, ref, signal, cache) {
  if (cache.has(uri)) return cache.get(uri);
  const res = await httpGet(uri, { ref, signal });
  if (!res.ok) throw new Error("HLS sifre anahtari alinamadi.");
  const raw = await res.arrayBuffer();
  const key = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
  cache.set(uri, key);
  return key;
}

function ivFor(keyInfo, index) {
  if (keyInfo.iv) {
    const hex = keyInfo.iv.replace(/^0x/i, "");
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return iv;
  }
  // IV verilmemisse segment sirasi 128-bit big-endian olarak kullanilir.
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, index >>> 0);
  return iv;
}

/** HLS listesindeki tum segmentleri indirir, gerekiyorsa cozer ve birlestirir. */
export async function downloadHls(playlistUrl, { ref, onProgress, signal } = {}) {
  const text = await fetchText(playlistUrl, ref, signal);
  const parsed = parseM3U8(text, playlistUrl);
  if (parsed.isMaster) throw new Error("Once bir kalite secilmeli.");
  if (!parsed.segments.length) throw new Error("Oynatma listesinde segment bulunamadi.");

  const keyCache = new Map();
  const parts = new Array(parsed.segments.length);
  let bytes = 0;
  let finished = 0;

  if (parsed.map) {
    const init = await downloadFile(parsed.map.url, { ref, signal });
    parts.unshift(init);
    bytes += init.byteLength;
  }

  const downloaded = await pool(parsed.segments, SEGMENT_CONCURRENCY, async (seg, i) => {
    const res = await httpGet(seg.url, { ref, signal });
    if (!res.ok) throw new Error(`Segment ${i + 1} indirilemedi (${res.status})`);
    let data = new Uint8Array(await res.arrayBuffer());
    if (seg.key && seg.key.method === "AES-128") {
      const key = await importKey(seg.key.uri, ref, signal, keyCache);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: ivFor(seg.key, seg.index) },
        key,
        data,
      );
      data = new Uint8Array(plain);
    }
    bytes += data.byteLength;
    finished++;
    onProgress?.(finished, parsed.segments.length, bytes);
    return data;
  });

  const all = parsed.map ? [parts[0], ...downloaded] : downloaded;
  return concatChunks(all);
}

/* ------------------------------------------------------------------ */
/* DASH                                                                */
/* ------------------------------------------------------------------ */

function mpdDurationToSeconds(value) {
  if (!value) return 0;
  const m = value.match(/P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  const [, , , d, h, min, s] = m.map((v) => (v ? parseFloat(v) : 0));
  return (d || 0) * 86400 + (h || 0) * 3600 + (min || 0) * 60 + (s || 0);
}

function fillTemplate(tpl, { id, number, time, bandwidth }) {
  return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_, name, pad) => {
    let value;
    if (name === "RepresentationID") value = id;
    else if (name === "Number") value = number;
    else if (name === "Time") value = time;
    else if (name === "Bandwidth") value = bandwidth;
    else return "$" + name + "$";
    const str = String(value ?? "");
    return pad ? str.padStart(Number(pad), "0") : str;
  });
}

/** MPD dosyasindan en iyi video ve ses temsillerini cikarir. */
export function parseMpd(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const mpd = doc.querySelector("MPD");
  if (!mpd) throw new Error("MPD dosyasi cozulemedi.");
  const totalDuration = mpdDurationToSeconds(mpd.getAttribute("mediaPresentationDuration"));
  const mpdBase = mpd.querySelector(":scope > BaseURL")?.textContent?.trim();
  const rootBase = mpdBase ? absolute(baseUrl, mpdBase) : baseUrl;

  const streams = [];
  for (const period of doc.querySelectorAll("Period")) {
    const periodBaseEl = period.querySelector(":scope > BaseURL");
    const periodBase = periodBaseEl ? absolute(rootBase, periodBaseEl.textContent.trim()) : rootBase;

    for (const set of period.querySelectorAll("AdaptationSet")) {
      const setBaseEl = set.querySelector(":scope > BaseURL");
      const setBase = setBaseEl ? absolute(periodBase, setBaseEl.textContent.trim()) : periodBase;
      const setMime = set.getAttribute("mimeType") || set.getAttribute("contentType") || "";

      for (const rep of set.querySelectorAll("Representation")) {
        const mime = rep.getAttribute("mimeType") || setMime;
        const type = mime.startsWith("audio") ? "audio" : mime.startsWith("video") ? "video" : "";
        if (!type) continue;
        const repBaseEl = rep.querySelector(":scope > BaseURL");
        const base = repBaseEl ? absolute(setBase, repBaseEl.textContent.trim()) : setBase;
        const template = rep.querySelector("SegmentTemplate") || set.querySelector(":scope > SegmentTemplate");
        const list = rep.querySelector("SegmentList") || set.querySelector(":scope > SegmentList");

        const stream = {
          type,
          id: rep.getAttribute("id") || "",
          bandwidth: Number(rep.getAttribute("bandwidth") || 0),
          width: Number(rep.getAttribute("width") || 0),
          height: Number(rep.getAttribute("height") || 0),
          codecs: rep.getAttribute("codecs") || "",
          mime,
          urls: [],
        };

        if (template) {
          const tplMedia = template.getAttribute("media");
          const tplInit = template.getAttribute("initialization");
          const timescale = Number(template.getAttribute("timescale") || 1);
          const startNumber = Number(template.getAttribute("startNumber") || 1);
          const args = { id: stream.id, bandwidth: stream.bandwidth };
          if (tplInit) stream.urls.push(absolute(base, fillTemplate(tplInit, args)));

          const timeline = template.querySelector("SegmentTimeline");
          if (timeline) {
            let time = 0;
            let number = startNumber;
            for (const s of timeline.querySelectorAll("S")) {
              const t = s.getAttribute("t");
              if (t !== null) time = Number(t);
              const d = Number(s.getAttribute("d") || 0);
              const r = Number(s.getAttribute("r") || 0);
              for (let i = 0; i <= r; i++) {
                stream.urls.push(absolute(base, fillTemplate(tplMedia, { ...args, number, time })));
                time += d;
                number++;
              }
            }
          } else {
            const segDuration = Number(template.getAttribute("duration") || 0) / timescale;
            const count = segDuration > 0 && totalDuration > 0 ? Math.ceil(totalDuration / segDuration) : 0;
            for (let i = 0; i < count; i++) {
              stream.urls.push(
                absolute(base, fillTemplate(tplMedia, { ...args, number: startNumber + i, time: i })),
              );
            }
          }
        } else if (list) {
          const init = list.querySelector("Initialization")?.getAttribute("sourceURL");
          if (init) stream.urls.push(absolute(base, init));
          for (const su of list.querySelectorAll("SegmentURL")) {
            const media = su.getAttribute("media");
            if (media) stream.urls.push(absolute(base, media));
          }
        } else {
          stream.urls.push(base); // SegmentBase: tek parca dosya
        }

        if (stream.urls.length) streams.push(stream);
      }
    }
  }

  const videos = streams.filter((s) => s.type === "video").sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const audios = streams.filter((s) => s.type === "audio").sort((a, b) => b.bandwidth - a.bandwidth);
  return { videos, audios, duration: totalDuration };
}

/** Bir DASH temsilinin tum segmentlerini indirip birlestirir. */
export async function downloadDashStream(stream, { ref, onProgress, signal } = {}) {
  if (stream.urls.length === 1) {
    return downloadFile(stream.urls[0], {
      ref,
      signal,
      onProgress: (done, total) => onProgress?.(done, total || 0, done),
    });
  }
  let finished = 0;
  let bytes = 0;
  const parts = await pool(stream.urls, SEGMENT_CONCURRENCY, async (url, i) => {
    const res = await httpGet(url, { ref, signal });
    if (!res.ok) throw new Error(`DASH parcasi ${i + 1} indirilemedi (${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    finished++;
    bytes += data.byteLength;
    onProgress?.(finished, stream.urls.length, bytes);
    return data;
  });
  return concatChunks(parts);
}
