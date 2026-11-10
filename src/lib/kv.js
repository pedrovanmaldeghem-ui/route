// Opslaglaag: één centrale wrapper rond Cloudflare KV, met dezelfde methodes als de
// Netlify-Blobs-store (get/setJSON/set/list/delete), zodat de rest van de code amper wijzigt.
// Later overschakelen naar R2 = enkel deze module vervangen.
//
// Eén KV-namespace draagt alle stores; elke store krijgt een eigen prefix ("lijnkijker:" / "auth:").
export function maakStore(kv, naam = "lijnkijker") {
  const p = (k) => `${naam}:${k}`;
  const af = (volledig) => volledig.slice(naam.length + 1); // haal de prefix er weer af
  return {
    async get(key, opt) {
      return kv.get(p(key), opt && opt.type === "json" ? "json" : "text");
    },
    // Leest een JSON-blob defensief: bij ongeldige of onderweg afgekapte JSON (bv. een afgebroken
    // schrijfbeurt) proberen we de geldige kop te redden — een map "sleutel":[...] die afgekapt is
    // knippen we na de laatste volledige entry en sluiten we weer af — en anders geven we de fallback.
    // Zo legt één corrupt blob nooit de poll (die leest-wijzigt-schrijft) of een zoekopdracht lam.
    async getJSONveilig(key, fallback = null) {
      const tekst = await kv.get(p(key), "text");
      if (tekst == null) return fallback;
      try { return JSON.parse(tekst); } catch { /* corrupt → proberen te redden */ }
      const i = tekst.lastIndexOf("],");
      if (i > 0) { try { return JSON.parse(tekst.slice(0, i + 1) + "}"); } catch { /* reddingspoging mislukt */ } }
      return fallback;
    },
    async setJSON(key, val) {
      return kv.put(p(key), JSON.stringify(val));
    },
    async set(key, val) {
      return kv.put(p(key), typeof val === "string" ? val : JSON.stringify(val));
    },
    // Geeft { blobs: [{ key }] } terug, net als Netlify Blobs. Pagineert over alle KV-sleutels.
    async list(opt) {
      const prefix = p((opt && opt.prefix) || "");
      let cursor, keys = [];
      do {
        const r = await kv.list({ prefix, cursor });
        keys.push(...r.keys);
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
      return { blobs: keys.map((x) => ({ key: af(x.name) })) };
    },
    async delete(key) {
      return kv.delete(p(key));
    },
  };
}
