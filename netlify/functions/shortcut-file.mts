/**
 * /avd.shortcut — kurulabilir iPhone Kisayolu dosyasi.
 *
 * Telefonda `shortcuts://import-shortcut?url=...` ile acildiginda Kisayollar
 * uygulamasi dosyayi indirir ve "Kisayol Ekle" ekranini gosterir; elle eylem
 * dizmek gerekmez.
 *
 * Dosya her istekte uretilir cunku icine sitenin kendi adresi gomulur:
 * projeyi kendi Netlify hesabina kuran birinin kisayolu da kendi adresine
 * istek atar.
 */

import type { Config, Context } from "@netlify/functions";
import { corsHeaders } from "../lib/net.mjs";
import { buildShortcut } from "../lib/shortcut-file.mjs";

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const params = new URL(req.url).searchParams;
  const type = /^(audio|ses|mp3|m4a)$/i.test(params.get("type") || "") ? "audio" : "video";
  const name = (params.get("name") || "").slice(0, 60).replace(/[\r\n"\\]/g, "").trim();

  // Alan adi: Netlify uc katmani asil adresi X-Forwarded-Host'ta tasiyor.
  const forwarded = req.headers.get("x-forwarded-host");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const origin = forwarded ? `${proto}://${forwarded}` : new URL(req.url).origin;

  const plist = buildShortcut({ origin, type, name: name || undefined });
  const filename = `${name || (type === "audio" ? "Sesi Indir" : "Videoyu Indir")}.shortcut`;

  return new Response(plist, {
    status: 200,
    headers: corsHeaders({
      // Kisayollar dosyayi tur bakmadan ayristirir; tarayicidan indirildiginde
      // de dogru adla kaydedilsin diye ad basliga yazilir.
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    }),
  });
};

export const config: Config = {
  path: "/avd.shortcut",
};
