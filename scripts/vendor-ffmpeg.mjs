/**
 * FFmpeg dosyalarini node_modules'ten public/vendor altina kopyalar.
 *
 * Boylece site calisma aninda ucuncu taraf bir CDN'e bagimli olmaz: dosyalar
 * Netlify'in kendi alan adindan, ayni kaynaktan servis edilir. Buyuk olduklari
 * icin depoya eklenmezler, her yapida yeniden uretilirler.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "vendor", "ffmpeg");

const FILES = [
  ["@ffmpeg/ffmpeg/dist/umd/ffmpeg.js", "ffmpeg.js"],
  ["@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js", "814.ffmpeg.js"],
  ["@ffmpeg/core/dist/umd/ffmpeg-core.js", "ffmpeg-core.js"],
  ["@ffmpeg/core/dist/umd/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
];

await mkdir(target, { recursive: true });

for (const [source, name] of FILES) {
  const from = join(root, "node_modules", source);
  const to = join(target, name);
  await cp(from, to);
  const { size } = await stat(to);
  console.log(`kopyalandi: ${name} (${(size / 1024).toFixed(0)} KB)`);
}

console.log(`FFmpeg dosyalari hazir: ${target}`);
