// D1: live busposities van de eigen netten (één rij per net + bus).
export function d1Aan(env) { return !!(env && env.DB); }
// --- Live busposities voor eigen netten -------------------------------------------------------
// Eén rij per (net, busnr): INSERT OR REPLACE houdt enkel de laatste positie bij, dus het aantal
// geschreven rijen = 1 per bus per melding en de tabel blijft piepklein. Lezen filtert op verse
// meldingen (tijd), zodat een bus die niet meer meldt vanzelf van de kaart verdwijnt.
let _eigenposKlaar = false;
const EIGENPOS_DDL =
  `CREATE TABLE IF NOT EXISTS eigenpos (
    net TEXT NOT NULL, busnr TEXT NOT NULL, type TEXT,
    lat REAL, lon REAL, hoek REAL,
    omloop TEXT, rit TEXT, lijn TEXT, bestemming TEXT, tijd INTEGER, vertraging INTEGER,
    PRIMARY KEY (net, busnr)
  ) WITHOUT ROWID`;
async function eigenposKlaar(env) {
  if (_eigenposKlaar) return;
  await env.DB.prepare(EIGENPOS_DDL).run();
  // Migratie voor een tabel die nog zonder 'vertraging' bestond (duplicate-column-fout negeren).
  try { await env.DB.prepare(`ALTER TABLE eigenpos ADD COLUMN vertraging INTEGER`).run(); } catch { /* kolom bestaat al */ }
  _eigenposKlaar = true;
}
export async function d1ZetEigenpos(env, p) {
  if (!d1Aan(env)) return false;
  await eigenposKlaar(env);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO eigenpos (net,busnr,type,lat,lon,hoek,omloop,rit,lijn,bestemming,tijd,vertraging) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    p.net, p.busnr, p.type || "", p.lat, p.lon, (p.hoek == null ? null : p.hoek),
    p.omloop || "", p.rit || "", p.lijn || "", p.bestemming || "", p.tijd,
    (p.vertraging == null ? null : p.vertraging)
  ).run();
  return true;
}
export async function d1LeesEigenpos(env, net, versMs = 180000) {
  if (!d1Aan(env)) return [];
  await eigenposKlaar(env);
  const grens = Date.now() - versMs;
  const r = await env.DB.prepare(
    `SELECT busnr,type,lat,lon,hoek,omloop,rit,lijn,bestemming,tijd,vertraging FROM eigenpos WHERE net=? AND tijd>? ORDER BY busnr`
  ).bind(net, grens).all();
  return (r && r.results) || [];
}
