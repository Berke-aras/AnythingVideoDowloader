/**
 * Kisayol sayfasi — kopyalanabilir adresler ve kucuk bir deneme kutusu.
 *
 * Adresler sayfada sabit yazilmaz: site hangi alan adinda duruyorsa kisayola
 * yazilacak adres de o olmalidir (yerelde netlify dev, canlida Netlify alan
 * adi, kendi kopyani kurduysan seninki).
 */

const $ = (id) => document.getElementById(id);
const base = location.origin;

/** Tariflerdeki "https://.../api/shortcut" yerlerini gercek adresle doldurur. */
function fillEndpoints() {
  const values = {
    endpoint: `${base}/api/shortcut`,
    textAction: `${base}/api/shortcut?redirect=1&url=`,
    textActionJson: `${base}/api/shortcut?url=`,
  };
  for (const [id, value] of Object.entries(values)) {
    const el = $(id);
    if (el) el.textContent = value;
  }
}

/**
 * Kurulum dugmeleri: iPhone'da `shortcuts://import-shortcut` semasi Kisayollar
 * uygulamasini acar ve "Kisayol Ekle" ekranini gosterir. Sema yalnizca iOS'ta
 * anlamli oldugu icin diger cihazlarda dugme dosyayi indirmeye devam eder
 * (HTML'deki href zaten /avd.shortcut'i gosteriyor).
 */
function wireInstallButtons() {
  const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
  const buttons = [
    { id: "installVideo", path: "/avd.shortcut", name: "Videoyu Indir" },
    { id: "installAudio", path: "/avd.shortcut?type=audio", name: "Sesi Indir" },
  ];

  for (const { id, path, name } of buttons) {
    const el = $(id);
    if (!el) continue;
    const fileUrl = `${base}${path}`;
    el.href = isApple
      ? `shortcuts://import-shortcut?url=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(name)}`
      : fileUrl;
    // Sema calismazsa (masaustu tarayici, eski iOS) dosyanin kendisi elde
    // kalsin diye dogrudan adres de gosterilir.
    el.dataset.fileUrl = fileUrl;
  }

  const note = $("installNote");
  if (note && !isApple) {
    note.insertAdjacentHTML(
      "afterbegin",
      "<p><strong>Bu cihaz iPhone degil:</strong> dugme kestirme dosyasini indirir. Kurulum " +
        "ancak telefonda yapilabilir — sayfayi iPhone'da ac ya da dosyayi telefonuna gonder.</p>",
    );
  }
}

/** Kopyala dugmeleri: pano yoksa metni secili birakmakla yetinir. */
function wireCopyButtons() {
  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const source = $(btn.dataset.copy);
      if (!source) return;
      const text = source.textContent;
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = "Kopyalandi";
        setTimeout(() => {
          btn.textContent = old;
        }, 1500);
      } catch {
        // Pano izni yoksa (ya da HTTP uzerindeysek) kullanici elle kopyalasin.
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  }
}

function setStatus(message, kind = "info") {
  const el = $("tryStatus");
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = message;
}

/** Ucun dondugu secenekleri indirilebilir baglantilar olarak listeler. */
function renderOptions(data) {
  const list = $("tryResults");
  list.textContent = "";
  const options = data.options?.length
    ? data.options
    : [{ label: data.quality, ext: data.ext, filename: data.filename, url: data.url }];

  for (const option of options) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = option.url;
    link.rel = "noreferrer noopener";
    const name = document.createElement("strong");
    name.textContent = option.label || option.filename;
    const detail = document.createElement("span");
    detail.className = "muted small";
    detail.textContent = `${option.filename} · ${(option.ext || "").toUpperCase()}`;
    link.append(name, detail);
    item.append(link);
    list.append(item);
  }
}

async function tryResolve(event) {
  event.preventDefault();
  const url = $("tryUrl").value.trim();
  if (!url) return;

  $("tryResults").textContent = "";
  setStatus("Cozumleniyor...");

  try {
    const res = await fetch(`/api/shortcut?list=1&url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.ok) {
      setStatus(data.message || "Cozumlenemedi.", "error");
      if (data.webUrl) {
        const list = $("tryResults");
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = data.webUrl;
        const name = document.createElement("strong");
        name.textContent = "Siteyi ac ve tarayicida indir";
        const detail = document.createElement("span");
        detail.className = "muted small";
        detail.textContent = "Birlestirme ve donusturme tarayicinda yapilir.";
        link.append(name, detail);
        item.append(link);
        list.append(item);
      }
      return;
    }
    setStatus(
      data.savesToPhotos
        ? `${data.title} — dosya Fotograflar'a dogrudan kaydedilebilir.`
        : `${data.title} — bu bicim Fotograflar'a girmez, Dosyalar'a kaydedilir.`,
      "info",
    );
    renderOptions(data);
  } catch (err) {
    setStatus(`Istek basarisiz: ${err.message}`, "error");
  }
}

fillEndpoints();
wireInstallButtons();
wireCopyButtons();
$("tryForm").addEventListener("submit", tryResolve);

// Paylasim menusunden ya da siteden adres gelmis olabilir.
const shared = new URLSearchParams(location.search).get("url");
if (shared) $("tryUrl").value = shared;
