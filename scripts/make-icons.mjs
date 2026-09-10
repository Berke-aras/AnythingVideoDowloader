/**
 * Uygulama simgelerini uretir (public/icons/).
 *
 * Telefona "ana ekrana ekle" ile kurulabilmesi icin manifest PNG simge ister.
 * Bagimlilik eklememek icin PNG'yi burada elle kodluyoruz: piksel dizisi
 * olusturulup zlib ile sikistiriliyor ve PNG kutulari yaziliyor.
 */

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BACKGROUND = [79, 70, 229]; // --accent ile ayni indigo
const FOREGROUND = [255, 255, 255];

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  // Her satir bir filtre baytiyla baslar (0 = filtre yok).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit derinligi
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // sikistirma
  ihdr[11] = 0; // filtre
  ihdr[12] = 0; // interlace yok

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Asagi bakan indirme oku: govde (dikdortgen) + ucgen uc. */
function isArrow(x, y, size) {
  const u = x / size;
  const v = y / size;

  const shaftTop = 0.22;
  const shaftBottom = 0.52;
  const shaftHalf = 0.085;
  if (v >= shaftTop && v <= shaftBottom && Math.abs(u - 0.5) <= shaftHalf) return true;

  // Ucgen: v=0.52'de genis, v=0.74'te tek noktada birlesir.
  const headTop = 0.52;
  const headBottom = 0.74;
  if (v >= headTop && v <= headBottom) {
    const t = (v - headTop) / (headBottom - headTop);
    if (Math.abs(u - 0.5) <= 0.24 * (1 - t)) return true;
  }

  // Alt cizgi (kaydetme yuzeyi)
  if (v >= 0.80 && v <= 0.865 && Math.abs(u - 0.5) <= 0.26) return true;
  return false;
}

/** Kose yuvarlatmasi; maskeli simgelerde de duzgun gorunsun diye yumusak. */
function insideRoundedSquare(x, y, size, radiusRatio) {
  const r = size * radiusRatio;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function makePixel({ maskable }) {
  return (x, y, size) => {
    // Maskeli simgede kenarlar kirpilabilir: zemin tam kare, icerik ortada kalir.
    const inBackground = maskable ? true : insideRoundedSquare(x + 0.5, y + 0.5, size, 0.22);
    if (!inBackground) return [0, 0, 0, 0];

    // Maskeli surumde ok, guvenli alanda kalsin diye kucultulur.
    const scale = maskable ? 0.72 : 1;
    const cx = size / 2;
    const cy = size / 2;
    const ax = (x - cx) / scale + cx;
    const ay = (y - cy) / scale + cy;

    if (ax >= 0 && ay >= 0 && ax < size && ay < size && isArrow(ax, ay, size)) {
      return [...FOREGROUND, 255];
    }
    return [...BACKGROUND, 255];
  };
}

await mkdir(OUT_DIR, { recursive: true });

const targets = [
  { name: "icon-192.png", size: 192, maskable: false },
  { name: "icon-512.png", size: 512, maskable: false },
  { name: "icon-maskable-512.png", size: 512, maskable: true },
  { name: "apple-touch-icon.png", size: 180, maskable: true },
];

for (const target of targets) {
  const png = encodePng(target.size, makePixel({ maskable: target.maskable }));
  await writeFile(join(OUT_DIR, target.name), png);
  console.log(`uretildi: ${target.name} (${target.size}px, ${(png.length / 1024).toFixed(1)} KB)`);
}
