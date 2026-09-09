/**
 * ffmpeg.wasm koprusu — donusturme ve birlestirme islerinin yapildigi yer.
 *
 * Tum islem kullanicinin tarayicisinda, ayri bir Web Worker icinde calisir:
 * sunucuya hicbir video byte'i islenmek uzere gonderilmez ve arayuz kilitlenmez.
 * Tek is parcacikli cekirdek kullanilir; boylece SharedArrayBuffer ve
 * COOP/COEP basliklari gerekmez, site her tarayicida acilir.
 *
 * Dosyalar ucuncu taraf bir CDN'den degil, sitenin kendi alan adindan yuklenir
 * (yapim asamasinda public/vendor/ffmpeg altina kopyalanirlar).
 */

const BASE = "/vendor/ffmpeg";

let ffmpegPromise = null;
let ffmpeg = null;

async function toBlobURL(url, mimeType, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FFmpeg dosyasi indirilemedi: ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const parts = [];
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    parts.push(value);
    done += value.byteLength;
    if (total) onProgress?.(done / total);
  }
  return URL.createObjectURL(new Blob(parts, { type: mimeType }));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("FFmpeg kitapligi yuklenemedi."));
    document.head.appendChild(el);
  });
}

/**
 * FFmpeg cekirdegini (yaklasik 32 MB) ilk ihtiyac aninda indirir ve baslatir.
 * Tarayici bu dosyayi onbellege aldigi icin sonraki indirmelerde beklenmez.
 */
export async function loadFFmpeg({ onStatus, onProgress } = {}) {
  if (ffmpeg) return ffmpeg;
  if (ffmpegPromise) return ffmpegPromise;

  ffmpegPromise = (async () => {
    onStatus?.("FFmpeg kitapligi yukleniyor...");
    if (!window.FFmpegWASM) {
      await loadScript(`${BASE}/ffmpeg.js`);
    }

    onStatus?.("FFmpeg cekirdegi indiriliyor (~32 MB, yalnizca ilk kullanimda)...");
    // Cekirdek Blob URL olarak verilir: hem ilerleme gosterebiliriz hem de
    // worker her tarayicida sorunsuz olusturulur.
    const wasmURL = await toBlobURL(`${BASE}/ffmpeg-core.wasm`, "application/wasm", (p) =>
      onProgress?.(p),
    );

    const instance = new window.FFmpegWASM.FFmpeg();
    // classWorkerURL bilerek verilmiyor: verildiginde kitaplik worker'i ES modulu
    // olarak acar ve cekirdegi yukleyen importScripts orada kullanilamaz. Dosyalar
    // zaten ayni kaynakta oldugu icin varsayilan (klasik) worker dogru cozulur.
    await instance.load({
      coreURL: new URL(`${BASE}/ffmpeg-core.js`, location.href).toString(),
      wasmURL,
    });
    // Cekirdek baslatildiktan sonra gecici Blob'u serbest birak.
    setTimeout(() => URL.revokeObjectURL(wasmURL), 30000);
    ffmpeg = instance;
    onStatus?.("FFmpeg hazir.");
    return instance;
  })();

  try {
    return await ffmpegPromise;
  } catch (err) {
    ffmpegPromise = null;
    throw err;
  }
}

export function isFFmpegLoaded() {
  return Boolean(ffmpeg);
}

/**
 * Girdileri bir kez worker bellegine yazar ve verilen komutlari sirayla dener.
 *
 * Denemeler tek cagride toplanir cunku `writeFile` girdinin ArrayBuffer'ini
 * worker'a devreder; devredilen tampon ana is parcaciginda kullanilamaz hale
 * gelir, dolayisiyla ayni veriyi ikinci kez yazmak mumkun degildir.
 *
 * @param {Array<{name: string, data: Uint8Array}>} inputs bellege yazilacak dosyalar
 * @param {Array<{args: string[], output: string, note?: string}>} attempts sirayla denenecek komutlar
 * @returns {Promise<{data: Uint8Array, output: string}>}
 */
export async function run(inputs, attempts, { onLog, onProgress, onStatus } = {}) {
  const fm = ffmpeg ?? (await loadFFmpeg({ onStatus, onProgress: (p) => onProgress?.(p, "yukleme") }));

  const logHandler = ({ message }) => onLog?.(message);
  const progressHandler = ({ progress }) => {
    if (Number.isFinite(progress)) onProgress?.(Math.min(Math.max(progress, 0), 1), "islem");
  };
  fm.on("log", logHandler);
  fm.on("progress", progressHandler);

  const written = [];
  try {
    for (const input of inputs) {
      await fm.writeFile(input.name, input.data);
      written.push(input.name);
    }

    let lastError = null;
    for (const [index, attempt] of attempts.entries()) {
      if (index > 0) {
        onStatus?.(attempt.note || "Alternatif bicim deneniyor...");
        onLog?.(`Onceki deneme basarisiz (${lastError?.message}); yeniden deneniyor.`);
      }
      onLog?.(`ffmpeg ${attempt.args.join(" ")}`);
      try {
        const code = await fm.exec(attempt.args);
        if (code !== 0) throw new Error(`FFmpeg ${code} kodu ile sonlandi.`);
        const data = await fm.readFile(attempt.output);
        return {
          data: data instanceof Uint8Array ? data : new Uint8Array(data),
          output: attempt.output,
        };
      } catch (err) {
        lastError = new Error(err?.message || "FFmpeg komutu calistirilamadi.");
        await fm.deleteFile(attempt.output).catch(() => {});
      }
    }
    throw lastError ?? new Error("Calistirilacak FFmpeg komutu verilmedi.");
  } finally {
    fm.off("log", logHandler);
    fm.off("progress", progressHandler);
    for (const name of written) {
      await fm.deleteFile(name).catch(() => {});
    }
    for (const attempt of attempts) {
      await fm.deleteFile(attempt.output).catch(() => {});
    }
  }
}

/**
 * Ayri video ve ses akislarini tek kapsayiciya birlestirir.
 * Varsayilan olarak yeniden kodlama yapilmaz (stream copy).
 */
export function mergeArgs(videoName, audioName, output, opts = {}) {
  const codec = opts.reencode
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k"]
    : ["-c", "copy", ...(opts.fromTs ? ["-bsf:a", "aac_adtstoasc"] : [])];
  return [
    "-i", videoName,
    "-i", audioName,
    ...codec,
    "-map", "0:v:0",
    "-map", "1:a:0",
    ...(output.endsWith(".mp4") ? ["-movflags", "+faststart"] : []),
    "-shortest",
    output,
  ];
}

/**
 * Hedef bicime gore ffmpeg argumanlarini uretir.
 * @param {{fromTs?: boolean}} opts MPEG-TS kaynaklarda AAC baslik donusumu gerekir.
 */
export function conversionArgs(inputName, format, output, opts = {}) {
  switch (format) {
    case "mp4":
      return [
        "-i", inputName,
        "-c", "copy",
        ...(opts.fromTs ? ["-bsf:a", "aac_adtstoasc"] : []),
        "-movflags", "+faststart",
        output,
      ];
    case "mp4-reencode":
      return ["-i", inputName, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output];
    case "mkv":
      return ["-i", inputName, "-c", "copy", output];
    case "mp3":
      return ["-i", inputName, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", output];
    case "m4a":
      return ["-i", inputName, "-vn", "-c:a", "copy", output];
    case "wav":
      return ["-i", inputName, "-vn", "-c:a", "pcm_s16le", output];
    default:
      return ["-i", inputName, "-c", "copy", output];
  }
}
