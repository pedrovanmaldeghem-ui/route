// Model van een eigen net: opschonen van wat de browser meestuurt, vóór we het bewaren.
// Overgenomen uit Lijnkijker (zelfde opslagformaat, zodat bestaande netten ongewijzigd meeverhuizen).
export const uurGeldig = (v, def) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : def);
function schoonVorm(arr) {
  // vormpunten buigen de lijn tussen twee haltes naar de weg; het zijn geen stopplaatsen
  return Array.isArray(arr) ? arr.slice(0, 300).map((v) => ({ lat: Number(v && v.lat), lon: Number(v && v.lon) })).filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)) : [];
}
function schoonHaltes(arr) {
  return Array.isArray(arr) ? arr.slice(0, 300).map((h) => ({
    naam: String(h && h.naam || "").slice(0, 80),
    lat: Number(h && h.lat), lon: Number(h && h.lon),
    reistijd: Math.max(0, Math.min(600, Math.round(Number(h && h.reistijd) || 0))), // min tot de VOLGENDE halte
    vorm: schoonVorm(h && h.vorm),
    vast: !!(h && h.vast), // segment ná deze halte is handmatig vastgezet → niet auto-overschrijven
  })).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon)) : [];
}
function schoonLijn(l) {
  const dagen = Array.isArray(l && l.dagen) ? [...new Set(l.dagen.map((d) => parseInt(d, 10)).filter((d) => d >= 1 && d <= 7))].sort() : [];
  return {
    lijn: String(l && l.lijn || "").slice(0, 20),
    heen: schoonHaltes(l && l.heen),
    terug: schoonHaltes(l && l.terug),
    venster: { van: uurGeldig(l && l.venster && l.venster.van, "06:00"), tot: uurGeldig(l && l.venster && l.venster.tot, "22:00") },
    vensterT: { van: uurGeldig(l && l.vensterT && l.vensterT.van, uurGeldig(l && l.venster && l.venster.van, "06:00")), tot: uurGeldig(l && l.vensterT && l.vensterT.tot, uurGeldig(l && l.venster && l.venster.tot, "22:00")) },
    terugAuto: !!(l && l.terugAuto),
    frequentie: Math.max(1, Math.min(120, Math.round(Number(l && l.frequentie) || 20))),
    keertijd: Math.max(0, Math.min(120, Math.round(Number(l && l.keertijd) || 5))),
    richtingen: (l && l.richtingen) === "heen" ? "heen" : "beide",
    dagen,
  };
}
// De projectie (per omloop de ritten) die de browser meestuurt, afgegrensd opschonen: dit is
// ongevraagde invoer die we bewaren én aan andere gebruikers tonen.
function schoonProjectie(p) {
  if (!p || typeof p !== "object" || !p.omlopen || typeof p.omlopen !== "object") return null;
  const omlopen = {};
  for (const [sl, rits] of Object.entries(p.omlopen).slice(0, 2000)) {
    if (!Array.isArray(rits)) continue;
    omlopen[String(sl).slice(0, 40)] = rits.slice(0, 3000).filter(Array.isArray).map((r) => [
      String(r[0] ?? "").slice(0, 12), String(r[1] ?? "").slice(0, 12),
      String(r[2] ?? "").slice(0, 80), String(r[3] ?? "").slice(0, 80),
      String(r[4] ?? "").slice(0, 6), String(r[5] ?? "").slice(0, 6),
      Array.isArray(r[6]) ? [...new Set(r[6].map((d) => Math.round(Number(d))).filter((d) => d >= 1 && d <= 7))].slice(0, 7) : [],
      Number.isFinite(+r[7]) ? +(+r[7]).toFixed(3) : 0,
      String(r[8] ?? "").slice(0, 40), // routesleutel (lijn+richting) voor de rit-detail in de boordcomputer
    ]);
  }
  // Routes: per lijn+richting de haltes (naam, lat, lon, reistijd) en de vormlijn [[lat,lon],...].
  const routes = {};
  if (p.routes && typeof p.routes === "object") {
    for (const [rk, rt] of Object.entries(p.routes).slice(0, 400)) {
      if (!rt || typeof rt !== "object") continue;
      const haltes = Array.isArray(rt.haltes) ? rt.haltes.slice(0, 400).filter(Array.isArray).map((h) => [
        String(h[0] ?? "").slice(0, 80),
        Number.isFinite(+h[1]) ? +(+h[1]).toFixed(6) : 0,
        Number.isFinite(+h[2]) ? +(+h[2]).toFixed(6) : 0,
        Math.max(0, Math.min(600, Math.round(Number(h[3]) || 0))),
      ]) : [];
      const pts = Array.isArray(rt.pts) ? rt.pts.slice(0, 4000).filter(Array.isArray).map((pt) => [
        Number.isFinite(+pt[0]) ? +(+pt[0]).toFixed(6) : 0,
        Number.isFinite(+pt[1]) ? +(+pt[1]).toFixed(6) : 0,
      ]) : [];
      routes[String(rk).slice(0, 40)] = { haltes, pts };
    }
  }
  return { omlopen, routes };
}
export function schoonNet(n, bestaand) {
  // Model: een net heeft een stelplaatsnummer en een lijst lijnen; elke lijn heeft een heen- en
  // (optioneel) terugroute. Omlopen worden over de lijnen heen gekoppeld op diensttijd, dus de
  // omloopnummering en de ritnummering staan op net-niveau. Oude netten (één enkele route op
  // net-niveau) worden mee ingelezen.
  let lijnen = Array.isArray(n && n.lijnen) ? n.lijnen : null;
  if (!lijnen && Array.isArray(n && n.haltes)) lijnen = [{ lijn: n.lijn, heen: n.haltes, terug: [], venster: n.venster, frequentie: n.frequentie, keertijd: n.keertijd, richtingen: n.richtingen, dagen: n.dagen }];
  lijnen = (lijnen || []).slice(0, 50).map(schoonLijn);
  return {
    id: (bestaand && bestaand.id) || String(n && n.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || ("net_" + Date.now().toString(36)),
    naam: String(n && n.naam || "").slice(0, 80) || "Naamloos net",
    publiekHaltebord: !!(n && n.publiekHaltebord), // haltebord-QR openbaar leesbaar (zonder login)
    stelplaatsen: Array.isArray(n && n.stelplaatsen) ? n.stelplaatsen.slice(0, 50).map((s) => ({ nr: String(s && s.nr || "").slice(0, 20), naam: String(s && s.naam || "").slice(0, 60), afk: String(s && s.afk || "").slice(0, 20), lat: Number(s && s.lat), lon: Number(s && s.lon) })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)) : [],
    omloopStart: Math.max(1, Math.min(999999, Math.round(Number(n && n.omloopStart) || 1))),
    ritStart: Math.max(0, Math.min(999999, Math.round(Number(n && n.ritStart) || 1))),
    ritModus: (n && n.ritModus) === "omloop" ? "omloop" : "doorlopend",
    ritNrs: (n && n.ritNrs && typeof n.ritNrs === "object") ? Object.fromEntries(Object.entries(n.ritNrs).slice(0, 5000).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 20)])) : {},
    omloopToewijzing: (n && n.omloopToewijzing && typeof n.omloopToewijzing === "object") ? Object.fromEntries(Object.entries(n.omloopToewijzing).slice(0, 5000).map(([k, v]) => [String(k).slice(0, 80), Math.max(0, Math.min(999999, Math.round(Number(v) || 0)))])) : {},
    aanmeld: Math.max(0, Math.min(120, Math.round(Number(n && n.aanmeld != null ? n.aanmeld : 5)))),
    afmeld: Math.max(0, Math.min(120, Math.round(Number(n && n.afmeld != null ? n.afmeld : 10)))),
    projectie: schoonProjectie(n && n.projectie),
    lijnen,
    gemaakt: (bestaand && bestaand.gemaakt) || Date.now(),
    gewijzigd: Date.now(),
  };
}
