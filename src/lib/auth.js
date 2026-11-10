// Login met e-mail + wachtwoord en goedkeuring door de beheerder.
// Gegevens in KV (store "auth"). Wachtwoorden met PBKDF2 gehasht, sessie met HMAC-cookie.
// Veilig uitrolbaar: zolang AUTH_SECRET niet is ingesteld, is de toegangscontrole UIT (site werkt zoals vroeger).
// De auth-store en de secrets (AUTH_SECRET, ADMIN_WACHTWOORD) komen uit Cloudflare env, meegegeven aan de functies.
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const vanB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// Aantal PBKDF2-rondes. Zwaarder = trager te kraken, MAAR Cloudflare Workers staat via Web Crypto
// hoogstens 100000 rondes toe (daarboven: "Pbkdf2 failed: iteration counts above 100000 are not
// supported"). We gebruiken dus het maximum dat Workers toelaat. Oude hashes (formaat "salt:hash",
// 100k rondes) blijven werken. Een hash die ooit met méér rondes werd gemaakt kan Workers niet
// narekenen; we begrenzen daarom hard op MAX_ITER zodat het nooit nog crasht (zo'n hash verifieert
// dan simpelweg niet, i.p.v. de hele aanvraag te laten falen).
const MAX_ITER = 100000;
const ITER = 100000;
const ITER_LEGACY = 100000;
async function deriveHash(wachtwoord, saltBytes, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(wachtwoord), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: Math.min(iter || ITER, MAX_ITER), hash: "SHA-256" }, key, 256);
  return b64url(bits);
}
export async function hashWachtwoord(wachtwoord, salt, iter = ITER) {
  salt = salt || b64url(crypto.getRandomValues(new Uint8Array(16)));
  return `${salt}:${iter}:${await deriveHash(wachtwoord, vanB64url(salt), iter)}`;
}
export async function checkWachtwoord(wachtwoord, opgeslagen) {
  if (!opgeslagen || !opgeslagen.includes(":")) return false;
  const p = opgeslagen.split(":");
  let salt, iter, hash;
  if (p.length >= 3) { salt = p[0]; iter = parseInt(p[1], 10) || ITER; hash = p[2]; }
  else { salt = p[0]; iter = ITER_LEGACY; hash = p[1]; } // oud formaat "salt:hash"
  const nieuw = await deriveHash(wachtwoord, vanB64url(salt), iter);
  // Lengte-onafhankelijke vergelijking.
  if (nieuw.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < nieuw.length; i++) diff |= nieuw.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
// Of een opgeslagen hash met een ouder/lichter formaat gemaakt is en bij login geüpgraded moet worden.
export const hashVerouderd = (opgeslagen) => {
  const p = String(opgeslagen || "").split(":");
  return p.length < 3 || (parseInt(p[1], 10) || 0) < ITER;
};

const geheim = (env) => env && env.AUTH_SECRET;
export const authAan = (env) => !!geheim(env);
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(geheim(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
// sid = een sessie-id dat één aanmelding (op één toestel) identificeert; zo kan de server oudere
// sessies ongeldig maken (max. aantal toestellen per account). Een willekeurig id.
export const nieuwSid = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
export async function maakToken(env, email, sid) {
  const body = b64url(enc.encode(JSON.stringify({ email, t: Date.now(), sid })));
  return `${body}.${await hmac(env, body)}`;
}
export async function leesToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || (await hmac(env, body)) !== sig) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(vanB64url(body)));
    if (!d.email || Date.now() - d.t > 30 * 86400000) return null; // 30 dagen geldig
    return { email: d.email, sid: d.sid || null };
  } catch { return null; }
}

export const emailKey = (email) => "users/" + String(email || "").trim().toLowerCase().replace(/[^a-z0-9._%+@-]/g, "_");
export const geldigEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "").trim());
export async function getUser(st, email) { return (await st.get(emailKey(email), { type: "json" })) || null; }
export async function zetUser(st, u) { await st.setJSON(emailKey(u.email), u); }
export async function alleUsers(st) {
  const { blobs } = await st.list({ prefix: "users/" });
  const uit = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
  return uit.filter(Boolean);
}

export const cookieZet = (token) => `sessie=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
export const cookieWis = () => "sessie=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
export function tokenUitReq(req) { const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)sessie=([^;]+)/); return m ? m[1] : null; }
// Max. aantal gelijktijdige sessies (toestellen) per account.
export const MAX_SESSIES = 2;
export async function huidigeUser(st, env, req) {
  const tok = await leesToken(env, tokenUitReq(req));
  if (!tok) return null;
  const u = await getUser(st, tok.email);
  if (!u || u.status !== "approved") return null;
  // Zodra een account sessies bijhoudt, moet het token-sid nog actief zijn (anders is dit toestel
  // uitgelogd omdat er elders opnieuw werd ingelogd). Oude tokens zonder sid gelden tot ze verlopen,
  // behalve wanneer het account al nieuwe sessies kent — dan is het oude toestel verdrongen.
  if (Array.isArray(u.sessies) && u.sessies.length) {
    if (!tok.sid || !u.sessies.some((s) => s.sid === tok.sid)) return null;
  }
  return u;
}
// Poort voor de data-API's: zolang AUTH_SECRET niet is ingesteld, staat alles open.
export async function vereisToegang(st, env, req) { return !authAan(env) ? true : !!(await huidigeUser(st, env, req)); }
export const beheerderOk = (env, w) => { const a = env && env.ADMIN_WACHTWOORD; return !!a && w === a; };
