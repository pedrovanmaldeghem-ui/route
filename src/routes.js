// Alle /api/*-routes van Eigennet. Elke handler krijgt (req, env, c) mee, met c = { st, authSt }.
import { d1ZetEigenpos, d1LeesEigenpos } from "./lib/d1.js";
import {
  authAan, huidigeUser, getUser, zetUser, alleUsers, emailKey,
  checkWachtwoord, hashWachtwoord, hashVerouderd, geldigEmail, maakToken, leesToken, tokenUitReq,
  cookieZet, cookieWis, beheerderOk, nieuwSid, MAX_SESSIES,
} from "./lib/auth.js";
import { schoonNet } from "./lib/net.js";

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

const netId = (v) => String(v || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);

// --- Rechten ------------------------------------------------------------------
// kijken = alle netten, omlopen en de boordcomputer; bouwer = netten aanmaken/bewerken/verwijderen.
// Het beheerderswachtwoord geeft altijd alles. Zolang AUTH_SECRET niet is ingesteld, staat alles open.
const RECHT_SLEUTELS = ["kijken", "bouwer"];
const schoonRechten = (r) => { const o = {}; for (const k of RECHT_SLEUTELS) o[k] = !!(r && r[k]); return o; };
async function heeftRecht(req, env, c, sleutel, beheer) {
  if (!authAan(env) || beheerderOk(env, beheer)) return true;
  const u = await huidigeUser(c.authSt, env, req);
  if (!u) return false;
  const r = u.rechten || {};
  return !!(r[sleutel] || (sleutel === "kijken" && r.bouwer)); // een bouwer mag ook kijken
}
const ingelogd = async (req, env, c) => !authAan(env) || !!(await huidigeUser(c.authSt, env, req));

// --- Auth ---------------------------------------------------------------------
const RL_MAX = 8, RL_VENSTER = 15 * 60 * 1000, RL_BLOK = 15 * 60 * 1000;
async function authLogin(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  try {
    if (!authAan(env)) return json({ fout: "Login staat nog niet aan (AUTH_SECRET ontbreekt)." }, 503);
    const nu = Date.now();
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const rlKey = `rl/login/${ip}`;
    const rl = (await c.authSt.get(rlKey, { type: "json" })) || { n: 0, start: nu };
    if (rl.until && rl.until > nu) return json({ fout: "Te veel mislukte pogingen. Wacht enkele minuten en probeer opnieuw." }, 429);
    if (nu - (rl.start || 0) > RL_VENSTER) { rl.n = 0; rl.start = nu; }
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase(), wachtwoord = String(b.wachtwoord || "");
    const u = await getUser(c.authSt, email);
    if (!u || !(await checkWachtwoord(wachtwoord, u.wachtwoord))) {
      rl.n = (rl.n || 0) + 1;
      if (rl.n >= RL_MAX) rl.until = nu + RL_BLOK;
      await c.authSt.setJSON(rlKey, rl);
      return json({ fout: "E-mailadres of wachtwoord klopt niet." }, 401);
    }
    if (u.status !== "approved") return json({ fout: "Je account wacht nog op goedkeuring door de beheerder.", status: u.status }, 403);
    await c.authSt.delete(rlKey).catch(() => {});
    if (hashVerouderd(u.wachtwoord)) { try { u.wachtwoord = await hashWachtwoord(wachtwoord); } catch {} }
    const sid = nieuwSid();
    const plaats = [req.cf && req.cf.city, req.cf && req.cf.country].filter(Boolean).join(", ") || "onbekend";
    const sessies = (Array.isArray(u.sessies) ? u.sessies : []).filter((s) => s && s.sid);
    sessies.unshift({ sid, wanneer: nu, ip, plaats });
    u.sessies = sessies.slice(0, MAX_SESSIES);
    await zetUser(c.authSt, u);
    return json({ ok: true, voornaam: u.voornaam }, 200, { "set-cookie": cookieZet(await maakToken(env, email, sid)) });
  } catch (e) {
    return json({ fout: "Serverfout bij inloggen: " + (e?.message || e) }, 500);
  }
}
async function authRegister(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const voornaam = String(b.voornaam || "").trim().slice(0, 60), naam = String(b.naam || "").trim().slice(0, 60);
    const email = String(b.email || "").trim().toLowerCase(), wachtwoord = String(b.wachtwoord || "");
    if (!voornaam || !naam) return json({ fout: "Vul je voornaam en naam in." }, 400);
    if (!geldigEmail(email)) return json({ fout: "Geef een geldig e-mailadres." }, 400);
    if (wachtwoord.length < 8) return json({ fout: "Kies een wachtwoord van minstens 8 tekens." }, 400);
    if (await getUser(c.authSt, email)) return json({ fout: "Er bestaat al een account met dit e-mailadres." }, 409);
    await zetUser(c.authSt, { email, voornaam, naam, wachtwoord: await hashWachtwoord(wachtwoord), status: "pending", aangemaakt: Date.now(), rechten: schoonRechten({ kijken: true }) });
    return json({ ok: true, status: "pending" });
  } catch (e) {
    return json({ fout: "Serverfout bij registreren: " + (e?.message || e) }, 500);
  }
}
async function authLogout(req, env, c) {
  try {
    const tok = authAan(env) ? await leesToken(env, tokenUitReq(req)) : null;
    if (tok && tok.sid) {
      const u = await getUser(c.authSt, tok.email);
      if (u && Array.isArray(u.sessies)) { u.sessies = u.sessies.filter((s) => s.sid !== tok.sid); await zetUser(c.authSt, u); }
    }
  } catch { /* uitloggen mag nooit falen */ }
  return json({ ok: true }, 200, { "set-cookie": cookieWis() });
}
async function authMe(req, env, c) {
  if (!authAan(env)) return json({ nodig: false, ingelogd: true, rechten: schoonRechten({ kijken: true, bouwer: true }) });
  const u = await huidigeUser(c.authSt, env, req);
  if (!u) return json({ nodig: true, ingelogd: false });
  const r = schoonRechten(u.rechten);
  if (r.bouwer) r.kijken = true;
  return json({ nodig: true, ingelogd: true, voornaam: u.voornaam, naam: u.naam, email: u.email, rechten: r });
}
async function authAdmin(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  const b = await req.json().catch(() => ({}));
  if (!beheerderOk(env, b.beheer)) return json({ fout: "Beheerderswachtwoord klopt niet." }, 401);
  const actie = b.actie || "lijst";
  if (actie === "lijst") {
    const rang = (s) => (s === "pending" ? 0 : 1);
    const users = (await alleUsers(c.authSt)).map(({ wachtwoord, sessies, ...rest }) => ({ ...rest, rechten: schoonRechten(rest.rechten) }))
      .sort((a, z) => rang(a.status) - rang(z.status) || (z.aangemaakt || 0) - (a.aangemaakt || 0));
    return json({ users, rechten: RECHT_SLEUTELS });
  }
  // Eenmalige verhuis: alle netten overnemen van een andere site (de oude Lijnkijker). De server haalt ze
  // daar op via /api/net (lijst + laad) en bewaart ze hier ongewijzigd. Bestaande netten met hetzelfde id
  // worden enkel overschreven als 'overschrijf' aan staat.
  // Netten uit back-upbestanden (de .raw.json-export van Lijnkijker: { net: {...} } of rechtstreeks het net).
  if (actie === "importeer-json") {
    const lijst = Array.isArray(b.nets) ? b.nets.slice(0, 50) : [];
    const uit = [];
    for (const ruw of lijst) {
      const n = ruw && typeof ruw === "object" && ruw.net && typeof ruw.net === "object" ? ruw.net : ruw;
      const id = netId(n && n.id);
      if (!id || !Array.isArray(n.lijnen)) { uit.push({ id: id || "?", naam: (n && n.naam) || "", status: "geen geldig net" }); continue; }
      if (!b.overschrijf && (await c.st.get(`net/${id}`))) { uit.push({ id, naam: n.naam, status: "bestond al" }); continue; }
      if (JSON.stringify(n).length > 20 * 1024 * 1024) { uit.push({ id, naam: n.naam, status: "te groot" }); continue; }
      await c.st.setJSON(`net/${id}`, n); // ongewijzigd bewaren, net als bij de overname van de oude site
      uit.push({ id, naam: n.naam, status: "overgenomen" });
    }
    return json({ ok: true, nets: uit });
  }
  if (actie === "importeer") {
    let bron;
    try { bron = new URL(String(b.bron || "")); } catch { return json({ fout: "Geef het volledige adres van de oude site, bv. https://lijnkijker.….workers.dev" }, 400); }
    if (bron.protocol !== "https:" && bron.hostname !== "localhost") return json({ fout: "Het adres moet met https:// beginnen." }, 400);
    const kop = { "content-type": "application/json" };
    if (b.tk) kop["x-test-key"] = String(b.tk);
    const vraag = async (body) => {
      const r = await fetch(new URL("/api/net", bron), { method: "POST", headers: kop, body: JSON.stringify({ beheer: b.oudBeheer || "", ...body }) });
      const t = await r.text();
      let d; try { d = JSON.parse(t); } catch { throw new Error(`oude site gaf geen JSON terug (${r.status}): ${t.slice(0, 120)}`); }
      if (!r.ok) throw new Error(d.fout || `fout ${r.status}`);
      return d;
    };
    try {
      const { nets = [] } = await vraag({ actie: "lijst" });
      const uit = [];
      for (const n of nets) {
        const id = netId(n.id);
        if (!id) continue;
        if (!b.overschrijf && (await c.st.get(`net/${id}`))) { uit.push({ id, naam: n.naam, status: "bestond al" }); continue; }
        const { net } = await vraag({ actie: "laad", id });
        if (!net) { uit.push({ id, naam: n.naam, status: "niet gevonden" }); continue; }
        await c.st.setJSON(`net/${id}`, net); // ongewijzigd overnemen (incl. projectie en datums)
        uit.push({ id, naam: net.naam || n.naam, status: "overgenomen" });
      }
      return json({ ok: true, nets: uit });
    } catch (e) { return json({ fout: "Overnemen mislukt: " + (e?.message || e) }, 502); }
  }
  const email = String(b.email || "").trim().toLowerCase();
  const u = await getUser(c.authSt, email);
  if (!u) return json({ fout: "Account niet gevonden." }, 404);
  if (actie === "approve") { u.status = "approved"; await zetUser(c.authSt, u); return json({ ok: true }); }
  if (actie === "reject") { u.status = "rejected"; await zetUser(c.authSt, u); return json({ ok: true }); }
  if (actie === "delete") { await c.authSt.delete(emailKey(email)); return json({ ok: true }); }
  if (actie === "recht") {
    const sleutel = String(b.sleutel || "");
    if (!RECHT_SLEUTELS.includes(sleutel)) return json({ fout: "onbekend recht" }, 400);
    u.rechten = schoonRechten(u.rechten); u.rechten[sleutel] = !!b.waarde;
    await zetUser(c.authSt, u); return json({ ok: true, rechten: u.rechten });
  }
  return json({ fout: "onbekende actie" }, 400);
}

// --- Netten -------------------------------------------------------------------
// Elk net is één JSON-blob in KV onder "net/<id>" (zelfde formaat als in Lijnkijker).
function samenvatting(net) {
  return {
    id: net.id, naam: net.naam, stelplaatsen: net.stelplaatsen.length, lijnen: net.lijnen.length,
    lijnnrs: net.lijnen.map((l) => l.lijn).filter(Boolean),
    heeftProjectie: !!(net.projectie && net.projectie.omlopen && Object.keys(net.projectie.omlopen).length),
    publiekHaltebord: !!net.publiekHaltebord, gewijzigd: net.gewijzigd,
  };
}
async function alleNetten(c) {
  const { blobs } = await c.st.list({ prefix: "net/" });
  const nets = [];
  for (const { key } of blobs) {
    const v = await c.st.getJSONveilig(key, null);
    if (v) nets.push(samenvatting(schoonNet(v, v)));
  }
  return nets.sort((a, z) => (z.gewijzigd || 0) - (a.gewijzigd || 0));
}
async function apiNet(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  const b = await req.json().catch(() => ({}));
  const actie = b.actie || "lijst";
  // Haltebord: openbaar leesbaar (zonder login) als het net 'publiekHaltebord' aan heeft staan.
  if (actie === "publiek-halte") {
    const v = await c.st.getJSONveilig(`net/${netId(b.id)}`, null);
    if (!v) return json({ fout: "Net niet gevonden." }, 404);
    const net = schoonNet(v, v);
    if (!net.publiekHaltebord && !(await heeftRecht(req, env, c, "kijken", b.beheer))) return json({ fout: "Dit haltebord is niet openbaar gezet." }, 403);
    return json({ net: { naam: net.naam, projectie: net.projectie, publiek: !!net.publiekHaltebord } }, 200, { "cache-control": "max-age=60" });
  }
  // Alleen lezen: de omlopenlijst, de boordcomputer en de read-only weergave.
  if (actie === "publiek-lijst" || actie === "publiek-laad") {
    if (!(await heeftRecht(req, env, c, "kijken", b.beheer))) return json({ fout: "Geen toegang tot de eigen netten. Log in of vraag de beheerder om toegang." }, 403);
    if (actie === "publiek-lijst") return json({ nets: await alleNetten(c) });
    const v = await c.st.getJSONveilig(`net/${netId(b.id)}`, null);
    if (!v) return json({ fout: "Net niet gevonden." }, 404);
    return json({ net: v });
  }
  // Bewerken (net-bouwer): enkel met het recht 'bouwer' of het beheerderswachtwoord.
  if (!(await heeftRecht(req, env, c, "bouwer", b.beheer))) return json({ fout: "Log in met een account dat netten mag bewerken, of geef het beheerderswachtwoord." }, 401);
  if (actie === "lijst") return json({ nets: await alleNetten(c) });
  if (actie === "laad") {
    const v = await c.st.getJSONveilig(`net/${netId(b.id)}`, null);
    if (!v) return json({ fout: "Net niet gevonden." }, 404);
    return json({ net: v });
  }
  if (actie === "bewaar") {
    const id = netId(b.net && b.net.id);
    const bestaand = id ? await c.st.getJSONveilig(`net/${id}`, null) : null;
    const net = schoonNet(b.net || {}, bestaand);
    if (!net.lijnen.length) return json({ fout: "Voeg minstens één lijn toe." }, 400);
    if (!net.lijnen.some((l) => l.heen.length >= 2)) return json({ fout: "Teken voor minstens één lijn een heenroute van twee haltes." }, 400);
    await c.st.setJSON(`net/${net.id}`, net);
    return json({ ok: true, net });
  }
  if (actie === "verwijder") {
    await c.st.delete(`net/${netId(b.id)}`).catch(() => {});
    return json({ ok: true });
  }
  return json({ fout: "onbekende actie" }, 400);
}

// --- Vaste routes (rijden zonder dienstregeling) -------------------------------
// Een route is een GPX (uit de routetekenaar of BRouter-web) met een naam, bv. "Omleiding Gent Zuid -
// Gent Sint-Pieters". De boordcomputer toont de lijst en rijdt een gekozen route zonder uren.
// KV: "routemeta/<id>" = { id, naam, km, haltes, gewijzigd } (klein, voor de lijst), "route/<id>" = de GPX.
const MAX_GPX = 3 * 1024 * 1024;
async function apiRoute(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  const b = await req.json().catch(() => ({}));
  const actie = b.actie || "lijst";
  if (actie === "lijst" || actie === "laad") {
    if (!(await heeftRecht(req, env, c, "kijken", b.beheer))) return json({ fout: "Log in om de routes te zien." }, 403);
    if (actie === "laad") {
      const id = netId(b.id);
      const [meta, gpx] = await Promise.all([c.st.getJSONveilig(`routemeta/${id}`, null), c.st.get(`route/${id}`)]);
      if (!meta || !gpx) return json({ fout: "Route niet gevonden." }, 404);
      return json({ route: { ...meta, gpx } });
    }
    const { blobs } = await c.st.list({ prefix: "routemeta/" });
    const routes = (await Promise.all(blobs.map(({ key }) => c.st.getJSONveilig(key, null)))).filter(Boolean);
    routes.sort((a, z) => String(a.naam).localeCompare(String(z.naam), "nl"));
    return json({ routes });
  }
  if (!(await heeftRecht(req, env, c, "bouwer", b.beheer))) return json({ fout: "Log in met een account met het recht Bouwer om routes op te slaan." }, 401);
  if (actie === "bewaar") {
    const naam = String(b.naam || "").trim().slice(0, 120);
    const gpx = String(b.gpx || "");
    if (!naam) return json({ fout: "Geef de route een naam." }, 400);
    if (!/<trkpt|<rtept/.test(gpx)) return json({ fout: "Dit is geen route (geen trackpunten)." }, 400);
    if (gpx.length > MAX_GPX) return json({ fout: "Deze route is te groot." }, 400);
    // Zelfde naam = dezelfde route overschrijven, tenzij er een id meekomt.
    let id = netId(b.id);
    if (!id) {
      const { blobs } = await c.st.list({ prefix: "routemeta/" });
      for (const { key } of blobs) {
        const m = await c.st.getJSONveilig(key, null);
        if (m && String(m.naam).toLowerCase() === naam.toLowerCase()) { id = m.id; break; }
      }
    }
    if (!id) id = "rt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = { id, naam, km: Math.round((Number(b.km) || 0) * 100) / 100, haltes: Math.max(0, parseInt(b.haltes, 10) || 0), gewijzigd: Date.now() };
    await c.st.set(`route/${id}`, gpx);
    await c.st.setJSON(`routemeta/${id}`, meta);
    return json({ ok: true, route: meta });
  }
  if (actie === "verwijder") {
    const id = netId(b.id);
    await Promise.all([c.st.delete(`route/${id}`).catch(() => {}), c.st.delete(`routemeta/${id}`).catch(() => {})]);
    return json({ ok: true });
  }
  return json({ fout: "onbekende actie" }, 400);
}

// --- Live busposities ---------------------------------------------------------
// "post" (chauffeur, ingelogd) bewaart de laatste positie in D1; "lees" geeft de verse posities —
// openbaar als het net 'publiekHaltebord' aan heeft staan, anders enkel met het recht 'kijken'.
async function apiEigenpos(req, env, c) {
  if (req.method !== "POST") return json({ fout: "methode" }, 405);
  const b = await req.json().catch(() => ({}));
  const actie = b.actie || "lees";
  const id = netId(b.net);
  if (!id) return json({ fout: "net ontbreekt" }, 400);
  if (actie === "post") {
    if (!(await ingelogd(req, env, c))) return json({ fout: "Log in om je positie te delen." }, 401);
    const busnr = String(b.busnr || "").slice(0, 20).trim();
    if (!busnr) return json({ fout: "busnummer ontbreekt" }, 400);
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ fout: "geen geldige positie" }, 400);
    try {
      await d1ZetEigenpos(env, {
        net: id, busnr, type: String(b.type || "").slice(0, 40),
        lat: +lat.toFixed(6), lon: +lon.toFixed(6),
        hoek: Number.isFinite(+b.hoek) ? Math.round(+b.hoek) : null,
        omloop: String(b.omloop || "").slice(0, 40), rit: String(b.rit || "").slice(0, 12),
        lijn: String(b.lijn || "").slice(0, 12), bestemming: String(b.bestemming || "").slice(0, 80),
        tijd: Date.now(),
        vertraging: (b.vertraging != null && Number.isFinite(+b.vertraging)) ? Math.max(-120, Math.min(600, Math.round(+b.vertraging))) : null,
      });
      return json({ ok: true });
    } catch { return json({ ok: false, fout: "Opslaan van positie mislukt." }); }
  }
  const v = await c.st.getJSONveilig(`net/${id}`, null);
  if (!v) return json({ fout: "Net niet gevonden." }, 404);
  const net = schoonNet(v, v);
  if (!net.publiekHaltebord && !(await heeftRecht(req, env, c, "kijken"))) return json({ fout: "Niet openbaar." }, 403);
  let buses = [];
  try { buses = await d1LeesEigenpos(env, id, 180000); } catch { buses = []; }
  return json({ naam: net.naam, buses }, 200, { "cache-control": "max-age=5" });
}

// De boordcomputer meldt welke omloop gestart wordt; hier hoeft dat niet bijgehouden te worden.
const apiStil = async () => json({ ok: true });

export const ROUTES = {
  "/api/login": authLogin,
  "/api/register": authRegister,
  "/api/logout": authLogout,
  "/api/me": authMe,
  "/api/admin": authAdmin,
  "/api/net": apiNet,
  "/api/eigenpos": apiEigenpos,
  "/api/route": apiRoute,
  "/api/omloopgebruik": apiStil,
  "/api/melden": apiStil,
};
