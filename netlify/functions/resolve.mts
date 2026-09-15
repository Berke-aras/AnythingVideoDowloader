/**
 * /api/resolve — sayfadaki medya adaylarini bulur.
 *
 * Isin tamami ../lib/resolver.mts icindedir; buradaki tek gorev istek
 * parametrelerini okumak ve sonucu JSON'a cevirmektir.
 */

import type { Config, Context } from "@netlify/functions";
import { assertSafeUrl, HttpError, jsonResponse } from "../lib/net.mjs";
import { resolvePage } from "../lib/resolver.mjs";

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

  try {
    return jsonResponse(await resolvePage(pageUrl, cookie));
  } catch (err) {
    const e = err as HttpError;
    return jsonResponse({ error: e.message }, e.status ?? 500);
  }
};

export const config: Config = {
  path: "/api/resolve",
};
