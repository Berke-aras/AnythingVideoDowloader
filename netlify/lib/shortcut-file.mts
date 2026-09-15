/**
 * Kurulabilir bir iPhone Kisayolu (.shortcut) uretir.
 *
 * Kisayol dosyasi aslinda bir XML plist'tir: `WFWorkflowActions` dizisindeki
 * her oge bir eylemdir. Eylemler birbirine UUID ile baglanir — bir eylemin
 * ciktisini kullanmak icin metnin icine U+FFFC (nesne yer tutucusu) konur ve
 * `attachmentsByRange` ile o karakterin hangi eylemin ciktisi oldugu yazilir.
 *
 * Dosya sunucuda uretiliyor cunku kisayolun icine sitenin **kendi adresi**
 * gomulmek zorunda: kullanicinin actigi alan adi neyse kisayol da oraya
 * istek atmali (kendi kopyasini kuran birinin kisayolu bizim siteye degil
 * kendi sitesine gitsin).
 *
 * Uretilen kisayol su akisi kurar:
 *   Paylasilan adres -> URL kodla -> /api/shortcut'a sor
 *     result = "ok"  ise: dosyayi indir ve kaydet
 *     degilse        ise: Turkce aciklamayi bildir ve siteyi ac
 */

/** Eylem ciktilarini metne gomerken kullanilan nesne yer tutucusu. */
const TOKEN = "￼";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Plist'e yazilacak sozluk/dizi/deger agacini XML'e cevirir. */
type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

function toXml(value: Plist, indent = "\t"): string {
  if (typeof value === "string") return `${indent}<string>${esc(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}<array/>`;
    const items = value.map((item) => toXml(item, `${indent}\t`)).join("\n");
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return `${indent}<dict/>`;
  const items = entries
    .map(([key, item]) => `${indent}\t<key>${esc(key)}</key>\n${toXml(item, `${indent}\t`)}`)
    .join("\n");
  return `${indent}<dict>\n${items}\n${indent}</dict>`;
}

/** Bir eylemin ciktisina yapilan tekil (metin olmayan) basvuru. */
function outputRef(uuid: string, name: string): Plist {
  return {
    Value: { OutputName: name, OutputUUID: uuid, Type: "ActionOutput" },
    WFSerializationType: "WFTextTokenAttachment",
  };
}

/** Icine eylem ciktisi gomulmus metin (sablon dizesi). */
function tokenText(parts: Array<string | { uuid: string; name: string }>): Plist {
  let text = "";
  const attachments: Record<string, Plist> = {};
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    attachments[`{${text.length}, 1}`] = {
      OutputName: part.name,
      OutputUUID: part.uuid,
      Type: "ActionOutput",
    };
    text += TOKEN;
  }
  return {
    Value: { attachmentsByRange: attachments, string: text },
    WFSerializationType: "WFTextTokenString",
  };
}

/** Kisayolun girdisi: paylasim sayfasindan gelen baglanti. */
function shortcutInput(): Plist {
  return {
    Value: {
      attachmentsByRange: { "{0, 1}": { Type: "ExtensionInput" } },
      string: TOKEN,
    },
    WFSerializationType: "WFTextTokenString",
  };
}

function action(identifier: string, parameters: Record<string, Plist>): Plist {
  return { WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: parameters };
}

/**
 * UUID'ler dosyaya sabit yazilir: ayni kisayol iki kez indirildiginde ayni
 * dosya cikar, boylece Kisayollar onu "ayni kisayolun yeni surumu" sayar.
 */
function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0").toUpperCase();
  return `A7D0${hex.slice(0, 4)}-${hex.slice(4, 8)}-4B1E-9C3A-${hex.padEnd(12, "0")}`;
}

export interface ShortcutOptions {
  /** Sitenin adresi (kisayolun icine gomulur). */
  origin: string;
  /** Video yerine ses indirmek icin "audio". */
  type?: "video" | "audio";
  /** Kisayolun adi. */
  name?: string;
}

/**
 * Kisayolu XML plist olarak uretir.
 *
 * Ses secildiginde dosya Fotograflar'a giremeyecegi icin "Dosyaya Kaydet"
 * eylemi kullanilir; video icin dogrudan Fotograflar'a kaydedilir.
 */
export function buildShortcut({ origin, type = "video", name }: ShortcutOptions): string {
  const isAudio = type === "audio";
  const query = `${origin}/api/shortcut?${isAudio ? "type=audio&" : ""}url=`;

  const uEncode = uuid(1);
  const uText = uuid(2);
  const uAsk = uuid(3);
  const uResult = uuid(4);
  const uMediaUrl = uuid(5);
  const uFile = uuid(6);
  const uMessage = uuid(7);
  const uWebUrl = uuid(8);
  const group = uuid(9);

  const actions: Plist[] = [
    // 1) Paylasilan adres kodlanir: ?v=...&t=... gibi adresler aksi halde
    //    kendi sorgumuzun icinde parcalanir.
    action("is.workflow.actions.urlencode", {
      UUID: uEncode,
      WFInput: shortcutInput(),
      WFEncodeMode: "Encode",
    }),

    // 2) Istek adresi kurulur.
    action("is.workflow.actions.gettext", {
      UUID: uText,
      WFTextActionText: tokenText([query, { uuid: uEncode, name: "URL Encoded Text" }]),
    }),

    // 3) Uc sorgulanir (JSON doner).
    action("is.workflow.actions.downloadurl", {
      UUID: uAsk,
      WFHTTPMethod: "GET",
      WFURL: tokenText([{ uuid: uText, name: "Text" }]),
    }),

    // 4) Sonuc "ok" mu? Uc bunu duz metin olarak veriyor; mantiksal deger
    //    karsilastirmasi cihazdan cihaza degisebiliyor, metin guvenli.
    action("is.workflow.actions.getvalueforkey", {
      UUID: uResult,
      WFDictionaryKey: "result",
      WFGetDictionaryValueType: "Value",
      WFInput: outputRef(uAsk, "Contents of URL"),
    }),

    // 5) Eger indirilebilir bir dosya bulunduysa...
    action("is.workflow.actions.conditional", {
      GroupingIdentifier: group,
      WFCondition: "Equals",
      WFConditionalActionString: "ok",
      WFControlFlowMode: 0,
      WFInput: outputRef(uResult, "Dictionary Value"),
    }),

    action("is.workflow.actions.getvalueforkey", {
      UUID: uMediaUrl,
      WFDictionaryKey: "url",
      WFGetDictionaryValueType: "Value",
      WFInput: outputRef(uAsk, "Contents of URL"),
    }),

    action("is.workflow.actions.downloadurl", {
      UUID: uFile,
      WFHTTPMethod: "GET",
      WFURL: tokenText([{ uuid: uMediaUrl, name: "Dictionary Value" }]),
    }),

    isAudio
      ? action("is.workflow.actions.documentpicker.save", {
          WFInput: outputRef(uFile, "Contents of URL"),
          WFAskWhereToSave: true,
        })
      : action("is.workflow.actions.savetocameraroll", {
          WFInput: outputRef(uFile, "Contents of URL"),
        }),

    // 6) ...yoksa nedenini bildir ve siteyi ac: birlestirme gereken videolarda
    //    isi tarayicidaki ffmpeg.wasm yapar.
    action("is.workflow.actions.conditional", {
      GroupingIdentifier: group,
      WFControlFlowMode: 1,
    }),

    action("is.workflow.actions.getvalueforkey", {
      UUID: uMessage,
      WFDictionaryKey: "message",
      WFGetDictionaryValueType: "Value",
      WFInput: outputRef(uAsk, "Contents of URL"),
    }),

    action("is.workflow.actions.notification", {
      WFNotificationActionBody: tokenText([{ uuid: uMessage, name: "Dictionary Value" }]),
      WFNotificationActionSound: false,
    }),

    action("is.workflow.actions.getvalueforkey", {
      UUID: uWebUrl,
      WFDictionaryKey: "webUrl",
      WFGetDictionaryValueType: "Value",
      WFInput: outputRef(uAsk, "Contents of URL"),
    }),

    action("is.workflow.actions.openurl", {
      WFInput: outputRef(uWebUrl, "Dictionary Value"),
    }),

    action("is.workflow.actions.conditional", {
      GroupingIdentifier: group,
      WFControlFlowMode: 2,
    }),
  ];

  const workflow: Plist = {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: "1146.6",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: {
      // Mor arkaplan + indirme oku: sitenin vurgu rengiyle ayni aileden.
      WFWorkflowIconGlyphNumber: 59511,
      WFWorkflowIconStartColor: 2071128575,
    },
    WFWorkflowImportQuestions: [],
    // Paylasim sayfasinda hangi icerikler icin gorunecegi.
    WFWorkflowInputContentItemClasses: [
      "WFURLContentItem",
      "WFStringContentItem",
      "WFSafariWebPageContentItem",
      "WFArticleContentItem",
      "WFRichTextContentItem",
    ],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowName: name || (isAudio ? "Sesi Indir" : "Videoyu Indir"),
    WFWorkflowTypes: ["ActionExtension"],
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    toXml(workflow, ""),
    "</plist>",
    "",
  ].join("\n");
}
