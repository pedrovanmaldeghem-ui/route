// Eigennet op Cloudflare Workers: één Worker voor de API (/api/*) en de statische bestanden (public/).
// Los van Lijnkijker: eigen KV (netten + accounts), eigen D1 (live busposities), eigen login.
import { maakStore } from "./lib/kv.js";
import { ROUTES, json } from "./routes.js";

const context = (env) => ({ st: maakStore(env.EIGENNET, "eigennet"), authSt: maakStore(env.EIGENNET, "auth") });

// Geheimen bij voorkeur uit Cloudflare-secrets; anders terugvallen op KV-sleutels met dezelfde naam.
const GEHEIM_NAMEN = ["AUTH_SECRET", "ADMIN_WACHTWOORD"];
let geheimCache = null, geheimTijd = 0;
async function metGeheimen(env) {
  if (GEHEIM_NAMEN.every((n) => env[n])) return env;
  const nu = Date.now();
  if (!geheimCache || nu - geheimTijd > 60000) {
    const paren = await Promise.all(GEHEIM_NAMEN.map(async (n) => { try { return [n, await env.EIGENNET.get(n)]; } catch { return [n, null]; } }));
    geheimCache = Object.fromEntries(paren.filter(([, v]) => v));
    geheimTijd = nu;
  }
  const uit = { ...env };
  for (const n of GEHEIM_NAMEN) if (!uit[n] && geheimCache[n]) uit[n] = geheimCache[n];
  return uit;
}

// Toegang beperken tot de Benelux, zoals Lijnkijker. Zet de variabele GEO_OPEN = "1" om dat uit te zetten.
const BENELUX = new Set(["BE", "NL", "LU"]);

// Korte namen. (/eigennet, /haltebord, /eigenkaart, /admin en /login werken vanzelf: Cloudflare
// serveert /x uit x.html, net als in Lijnkijker, zodat de oude links en QR-codes hier ook passen.)
const ALIAS = { "/bouwer": "/eigennet", "/kaart": "/eigenkaart" };

async function naarBrouterWeb(req, env, url) {
  const z = Math.max(5, Math.min(19, parseInt(url.searchParams.get("z") || "", 10) || 14));
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  const plek = Number.isFinite(lat) && Number.isFinite(lon) && lat && lon ? `${z}/${lat.toFixed(5)}/${lon.toFixed(5)}` : `${z}/51.03570/3.71060`;
  let profiel = "car-vario";
  try {
    const brf = await (await env.ASSETS.fetch(new Request(new URL("/routetekenaar/bus.brf", url)))).text();
    const d = await (await fetch("https://brouter.de/brouter/profile", { method: "POST", body: brf })).json();
    if (d && d.profileid && !d.error) profiel = d.profileid;
  } catch { /* BRouter onbereikbaar: dan het gewone autoprofiel */ }
  return Response.redirect(`https://brouter.de/brouter-web/#map=${plek}/standard&profile=${encodeURIComponent(profiel)}`, 302);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const land = req.cf && req.cf.country;
    if (env.GEO_OPEN !== "1" && land && !BENELUX.has(land)) {
      return new Response("Deze site is enkel toegankelijk vanuit de Benelux (België, Nederland, Luxemburg).", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // /brouter: BRouter-web openen met ons busprofiel al ingesteld. Het profiel wordt telkens vers naar de
    // BRouter-server gestuurd (die bewaart opgeladen profielen maar tijdelijk) en we sturen door naar
    // BRouter-web met profile=custom_…; optioneel ?z=&lat=&lon= voor de kaartplek.
    if (url.pathname === "/brouter") return naarBrouterWeb(req, env, url);
    const handler = ROUTES[url.pathname];
    if (handler) {
      try { return await handler(req, await metGeheimen(env), context(env)); }
      catch (e) { return json({ fout: "Serverfout: " + (e?.message || e) }, 500); }
    }
    let assetReq = req;
    if (ALIAS[url.pathname]) { const u2 = new URL(req.url); u2.pathname = ALIAS[url.pathname]; assetReq = new Request(u2, req); }
    const res = await env.ASSETS.fetch(assetReq);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && /text\/html|application\/json/.test(ct)) {
      const h = new Headers(res.headers);
      h.set("cache-control", "no-cache");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
