/**
 * Arayuz orkestrasyonu: cozumleme -> kaynak secimi -> indirme -> donusturme.
 */

import {
  downloadDashStream,
  downloadFile,
  downloadHls,
  fetchText,
  parseM3U8,
  parseMpd,
} from "./engine.js";
import { conversionArgs, isFFmpegLoaded, loadFFmpeg, mergeArgs, run } from "./ffmpeg.js";

const $ = (id) => document.getElementById(id);

const els = {
  form: $("resolveForm"),
  url: $("urlInput"),
  resolveBtn: $("resolveBtn"),
  resolveStatus: $("resolveStatus"),
  resultCard: $("resultCard"),
  poster: $("poster"),
  title: $("mediaTitle"),
  source: $("mediaSource"),
  note: $("mediaNote"),
  list: $("candidateList"),
  optionsCard: $("optionsCard"),
  pickers: $("streamPickers"),
  format: $("formatSelect"),
  formatHint: $("formatHint"),
  downloadBtn: $("downloadBtn"),
  cancelBtn: $("cancelBtn"),
  progressCard: $("progressCard"),
  stage: $("stageText"),
  bar: $("bar"),
  detail: $("stageDetail"),
  result: $("resultArea"),
  log: $("log"),
  cpuChip: $("cpuChip"),
};

/** Uygulama durumu. */
const state = { page: null, candidate: null, plan: null, controller: null };

const AUDIO_FORMATS = new Set(["mp3", "m4a", "wav"]);

/* --------------------------- yardimcilar --------------------------- */

function bytesToSize(n) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function safeFileName(name, ext) {
  const base =
    (name || "video")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "video";
  return `${base}.${ext}`;
}

function setStatus(message, kind = "info") {
  if (!message) {
    els.resolveStatus.hidden = true;
    return;
  }
  els.resolveStatus.hidden = false;
  els.resolveStatus.className = `status ${kind}`;
  els.resolveStatus.textContent = message;
}

function log(line) {
  els.log.textContent += `${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setProgress(fraction) {
  if (fraction === null) {
    els.bar.classList.add("indeterminate");
    return;
  }
  els.bar.classList.remove("indeterminate");
  els.bar.style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

function setStage(text, detail = "") {
  els.stage.textContent = text;
  els.detail.textContent = detail;
}

/* --------------------------- cozumleme ---------------------------- */

async function resolveUrl(event) {
  event.preventDefault();
  const url = els.url.value.trim();
  if (!url) return;

  els.resolveBtn.disabled = true;
  setStatus("Sayfa inceleniyor...");
  els.resultCard.hidden = true;
  els.optionsCard.hidden = true;
  els.progressCard.hidden = true;
  state.candidate = null;
  state.plan = null;

  try {
    const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Sunucu hatasi (${res.status})`);
    state.page = data;
    renderResult(data);
    setStatus(
      data.candidates.length
        ? `${data.candidates.length} kaynak bulundu. Birini secerek devam et.`
        : "Bu sayfada indirilebilir medya bulunamadi.",
      data.candidates.length ? "info" : "error",
    );
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    els.resolveBtn.disabled = false;
  }
}

function renderResult(data) {
  els.resultCard.hidden = false;
  els.title.textContent = data.title || "Adsiz medya";
  els.source.textContent = data.pageUrl;
  els.note.hidden = !data.note;
  els.note.textContent = data.note || "";
  if (data.poster) {
    els.poster.src = data.poster;
    els.poster.hidden = false;
  } else {
    els.poster.hidden = true;
  }

  els.list.textContent = "";
  for (const candidate of data.candidates) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "candidate";
    btn.setAttribute("aria-pressed", "false");

    const badge = document.createElement("span");
    badge.className = `badge ${candidate.kind}`;
    badge.textContent =
      candidate.kind === "hls"
        ? "HLS"
        : candidate.kind === "dash"
          ? "DASH"
          : candidate.kind === "audio"
            ? "SES"
            : "VIDEO";

    const text = document.createElement("span");
    text.className = "candidate-text";
    const strong = document.createElement("strong");
    strong.textContent = candidate.label;
    const span = document.createElement("span");
    span.textContent = candidate.url;
    text.append(strong, span);

    btn.append(badge, text);
    btn.addEventListener("click", () => selectCandidate(candidate, btn));
    li.append(btn);
    els.list.append(li);
  }
}

/* ------------------------ kaynak secimi --------------------------- */

async function selectCandidate(candidate, button) {
  for (const el of els.list.querySelectorAll(".candidate")) {
    el.setAttribute("aria-pressed", String(el === button));
  }
  state.candidate = candidate;
  els.optionsCard.hidden = false;
  els.pickers.textContent = "";
  els.downloadBtn.disabled = true;
  els.formatHint.textContent = "Kaynak inceleniyor...";

  try {
    if (candidate.kind === "hls") {
      await prepareHls(candidate);
    } else if (candidate.kind === "dash") {
      await prepareDash(candidate);
    } else {
      state.plan = { type: "progressive", url: candidate.url, ext: candidate.ext || "mp4" };
    }
    buildFormatOptions();
    els.downloadBtn.disabled = false;
  } catch (err) {
    els.formatHint.textContent = "";
    els.pickers.textContent = "";
    setStatus(`Kaynak hazirlanamadi: ${err.message}`, "error");
    els.optionsCard.hidden = true;
  }
}

function addPicker(labelText, options, onChange) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;
  const select = document.createElement("select");
  options.forEach((opt, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = opt.label;
    select.append(option);
  });
  select.addEventListener("change", () => onChange(Number(select.value)));
  label.append(span, select);
  els.pickers.append(label);
  onChange(0);
}

async function prepareHls(candidate) {
  const text = await fetchText(candidate.url, state.page.pageUrl);
  const parsed = parseM3U8(text, candidate.url);

  if (!parsed.isMaster) {
    state.plan = { type: "hls", videoUrl: candidate.url, audioUrl: null, ext: "ts" };
    return;
  }
  if (!parsed.variants.length) throw new Error("Oynatma listesinde kalite bulunamadi.");

  const options = parsed.variants.map((v) => ({
    label: [
      v.height ? `${v.height}p` : "bilinmeyen cozunurluk",
      v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : "",
      v.codecs,
    ]
      .filter(Boolean)
      .join(" - "),
    variant: v,
  }));

  addPicker("Kalite", options, (index) => {
    const variant = options[index].variant;
    const group = parsed.audioGroups[variant.audioGroup] || [];
    const audio = group.find((a) => a.isDefault) || group[0] || null;
    state.plan = {
      type: "hls",
      videoUrl: variant.url,
      audioUrl: audio ? audio.url : null,
      ext: "ts",
    };
  });
}

async function prepareDash(candidate) {
  const text = await fetchText(candidate.url, state.page.pageUrl);
  const parsed = parseMpd(text, candidate.url);
  if (!parsed.videos.length && !parsed.audios.length) {
    throw new Error("MPD icinde kullanilabilir akis yok.");
  }

  const plan = {
    type: "dash",
    video: parsed.videos[0] || null,
    audio: parsed.audios[0] || null,
    ext: "mp4",
  };
  state.plan = plan;

  if (parsed.videos.length) {
    const options = parsed.videos.map((v) => ({
      label: [
        v.height ? `${v.height}p` : "video",
        v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : "",
        v.codecs,
      ]
        .filter(Boolean)
        .join(" - "),
      stream: v,
    }));
    addPicker("Video akisi", options, (index) => {
      plan.video = options[index].stream;
    });
  }
  if (parsed.audios.length) {
    const options = parsed.audios.map((a) => ({
      label: [a.bandwidth ? `${Math.round(a.bandwidth / 1000)} kbps` : "ses", a.codecs]
        .filter(Boolean)
        .join(" - "),
      stream: a,
    }));
    addPicker("Ses akisi", options, (index) => {
      plan.audio = options[index].stream;
    });
  }
}

function buildFormatOptions() {
  const plan = state.plan;
  const hasVideo =
    plan.type === "dash" ? Boolean(plan.video) : state.candidate.kind !== "audio";
  const singleStream =
    plan.type === "progressive" ||
    (plan.type === "hls" && !plan.audioUrl) ||
    (plan.type === "dash" && !(plan.video && plan.audio));

  const options = [];
  if (hasVideo) {
    options.push({ value: "mp4", label: "MP4 - yeniden kodlamadan (hizli, onerilen)" });
    options.push({ value: "mkv", label: "MKV - her codec ile uyumlu kapsayici" });
    options.push({ value: "mp4-reencode", label: "MP4 - yeniden kodla (yavas, en genis uyumluluk)" });
  }
  options.push({ value: "mp3", label: "MP3 - yalnizca ses (192 kbps)" });
  options.push({ value: "m4a", label: "M4A - yalnizca ses, yeniden kodlamadan" });
  options.push({ value: "wav", label: "WAV - yalnizca ses, sikistirmasiz" });
  if (singleStream) {
    options.push({ value: "original", label: `Orijinal dosya - hic islem yapma (.${plan.ext})` });
  }

  els.format.textContent = "";
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    els.format.append(el);
  }
  updateFormatHint();
}

function updateFormatHint() {
  const value = els.format.value;
  if (value === "original") {
    els.formatHint.textContent = "Dosya oldugu gibi kaydedilir; FFmpeg indirilmez.";
  } else if (value === "mp4-reencode") {
    els.formatHint.textContent =
      "Video yeniden kodlanir. Islemcini uzun sure mesgul eder; uzun videolarda dakikalar surebilir.";
  } else if (AUDIO_FORMATS.has(value)) {
    els.formatHint.textContent = "Yalnizca ses akisi alinir ve secilen bicime yazilir.";
  } else {
    els.formatHint.textContent =
      "Akislar yeniden kodlanmadan kopyalanir, kalite kaybi olmaz. Ilk kullanimda bir kez ~32 MB FFmpeg cekirdegi indirilir.";
  }
}

/* --------------------------- indirme ------------------------------ */

/** Plana gore indirilecek akislari belirler. */
function planStreams(plan, wantsAudioOnly) {
  if (plan.type === "hls") {
    if (wantsAudioOnly && plan.audioUrl) return [{ url: plan.audioUrl, role: "video" }];
    const list = [{ url: plan.videoUrl, role: "video" }];
    if (plan.audioUrl && !wantsAudioOnly) list.push({ url: plan.audioUrl, role: "audio" });
    return list;
  }
  if (wantsAudioOnly && plan.audio) return [{ stream: plan.audio, role: "video" }];
  const list = [];
  if (plan.video) list.push({ stream: plan.video, role: "video" });
  if (plan.audio && !wantsAudioOnly) list.push({ stream: plan.audio, role: "audio" });
  return list.length ? list : [{ stream: plan.audio || plan.video, role: "video" }];
}

async function startDownload() {
  const plan = state.plan;
  const format = els.format.value;
  if (!plan) return;

  state.controller = new AbortController();
  const signal = state.controller.signal;
  const ref = state.page?.pageUrl;

  els.progressCard.hidden = false;
  els.result.hidden = true;
  els.result.className = "result";
  els.log.textContent = "";
  els.downloadBtn.disabled = true;
  els.cancelBtn.hidden = false;
  els.progressCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const wantsAudioOnly = AUDIO_FORMATS.has(format);
  const needsFFmpeg = format !== "original";
  const downloadWeight = needsFFmpeg ? 0.75 : 1;

  try {
    let videoData = null;
    let audioData = null;
    const fromTs = plan.type === "hls";

    if (plan.type === "progressive") {
      setStage("Dosya indiriliyor", "Parcalar paralel olarak cekiliyor.");
      videoData = await downloadFile(plan.url, {
        ref,
        signal,
        onProgress: (done, total) => {
          setProgress(total ? (done / total) * downloadWeight : null);
          setStage(
            "Dosya indiriliyor",
            `${bytesToSize(done)}${total ? ` / ${bytesToSize(total)}` : ""}`,
          );
        },
      });
    } else {
      const streams = planStreams(plan, wantsAudioOnly);
      for (const [i, item] of streams.entries()) {
        const suffix = streams.length > 1 ? ` (${i + 1}/${streams.length})` : "";
        const onProgress = (done, total, bytes) => {
          const base = total ? (i + done / total) / streams.length : i / streams.length;
          setProgress(base * downloadWeight);
          setStage(
            plan.type === "hls" ? `HLS segmentleri indiriliyor${suffix}` : `DASH parcalari indiriliyor${suffix}`,
            `${done}/${total || "?"} parca - ${bytesToSize(bytes)}`,
          );
        };
        const data =
          plan.type === "hls"
            ? await downloadHls(item.url, { ref, signal, onProgress })
            : await downloadDashStream(item.stream, { ref, signal, onProgress });
        if (item.role === "video") videoData = data;
        else audioData = data;
      }
    }

    if (!videoData) throw new Error("Indirilecek veri bulunamadi.");
    log(`Indirilen veri: ${bytesToSize(videoData.byteLength + (audioData?.byteLength || 0))}`);

    if (!needsFFmpeg) {
      finish(new Blob([videoData]), safeFileName(state.page?.title, plan.ext));
      return;
    }

    if (videoData.byteLength + (audioData?.byteLength || 0) > 1.4 * 1024 ** 3) {
      log("Uyari: dosya cok buyuk, tarayici bellegi yetmeyebilir.");
    }

    const outExt = format === "mp4-reencode" ? "mp4" : format;
    const inputs = [{ name: `in_v.${plan.ext}`, data: videoData }];
    if (audioData) inputs.push({ name: `in_a.${plan.ext}`, data: audioData });

    /** Secilen bicim icin ffmpeg argumanlarini uretir. */
    const buildArgs = (targetFormat, output) =>
      audioData && !wantsAudioOnly
        ? mergeArgs(inputs[0].name, inputs[1].name, output, {
            fromTs,
            reencode: targetFormat === "mp4-reencode",
          })
        : conversionArgs(inputs[0].name, targetFormat, output, { fromTs });

    const attempts = [{ args: buildArgs(format, `out.${outExt}`), output: `out.${outExt}` }];
    // MP4 her codec'i kabul etmez (ornegin VP9 + Opus). Kopyalama basarisiz
    // olursa ayni akislari kayipsiz sekilde MKV kapsayicisina yaz.
    if (format === "mp4") {
      attempts.push({
        args: buildArgs("mkv", "out.mkv"),
        output: "out.mkv",
        note: "MP4 uygun degil, MKV deneniyor...",
      });
    }

    setStage("FFmpeg calisiyor", "Islem bilgisayarinin islemcisinde yapiliyor.");
    setProgress(isFFmpegLoaded() ? downloadWeight : null);

    const ffmpegOptions = {
      onLog: log,
      onStatus: (message) => setStage("FFmpeg calisiyor", message),
      onProgress: (value, phase) => {
        if (phase === "islem") {
          setProgress(downloadWeight + value * (1 - downloadWeight));
          setStage("FFmpeg calisiyor", `%${Math.round(value * 100)} donusturuldu`);
        } else {
          setStage("FFmpeg hazirlaniyor", `Cekirdek indiriliyor %${Math.round(value * 100)}`);
        }
      },
    };

    // Cekirdegi ayri bir adimda yukle: boylece bir yukleme hatasi, komut
    // denemelerinin arasina karisip yaniltici bir mesaj uretmez.
    await loadFFmpeg({
      onStatus: (message) => setStage("FFmpeg hazirlaniyor", message),
      onProgress: (value) => {
        setProgress(null);
        setStage("FFmpeg hazirlaniyor", `Cekirdek indiriliyor %${Math.round(value * 100)}`);
      },
    });

    const { data, output } = await run(inputs, attempts, ffmpegOptions);
    finish(new Blob([data]), safeFileName(state.page?.title, output.split(".").pop()));
  } catch (err) {
    if (err.name === "AbortError") {
      setStage("Iptal edildi", "");
      setProgress(0);
    } else {
      showError(err);
    }
  } finally {
    els.downloadBtn.disabled = false;
    els.cancelBtn.hidden = true;
    state.controller = null;
  }
}

function finish(blob, fileName) {
  setStage("Tamamlandi", `${bytesToSize(blob.size)} - ${fileName}`);
  setProgress(1);

  const url = URL.createObjectURL(blob);
  els.result.hidden = false;
  els.result.className = "result";
  els.result.textContent = "";

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.textContent = `${fileName} dosyasini kaydet (${bytesToSize(blob.size)})`;
  els.result.append(link);

  link.click(); // tarayici indirmeyi hemen baslatsin
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

function showError(err) {
  setStage("Hata", "");
  els.result.hidden = false;
  els.result.className = "result error";
  els.result.textContent = err.message || String(err);
  log(`HATA: ${err.message}`);
}

/* ---------------------------- baslat ------------------------------ */

els.form.addEventListener("submit", resolveUrl);
els.downloadBtn.addEventListener("click", startDownload);
els.cancelBtn.addEventListener("click", () => state.controller?.abort());
els.format.addEventListener("change", updateFormatHint);

if (navigator.hardwareConcurrency) {
  els.cpuChip.textContent = `${navigator.hardwareConcurrency} cekirdek - yerel islem`;
}

const shared = new URLSearchParams(location.search).get("url");
if (shared) {
  els.url.value = shared;
  els.form.requestSubmit();
}
