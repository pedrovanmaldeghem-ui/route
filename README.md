# Eigennet

Zelf geplande busnetten: de net-bouwer, de omlopen per dag, de boordcomputer, de live kaart en de
halteborden met QR. Losgemaakt uit Lijnkijker, zodat het in een eigen Cloudflare-account draait met
een eigen opslag en een eigen login.

| Pagina | Wat |
| --- | --- |
| `/` | Omlopen per net en per dag, met een knop naar de boordcomputer |
| `/boord/` | Boordcomputer (installeerbaar op de telefoon), enkel voor eigen netten |
| `/eigennet` | Net-bouwer (recht **Bouwer** of beheerderswachtwoord) |
| `/eigenkaart?net=…` | Live kaart met de bussen die hun positie delen |
| `/haltebord?net=…` | Printbare halteborden met QR naar de live doorkomsten |
| `/login` | Inloggen of een account aanvragen |
| `/admin` | Accounts goedkeuren, rechten geven, netten overnemen uit Lijnkijker |

Opslag: KV `EIGENNET` (netten onder `eigennet:net/<id>`, accounts onder `auth:`) en D1 `DB`
(tabel `eigenpos`, de laatst gemelde positie per bus; wordt vanzelf aangemaakt).

## Uitrollen in het nieuwe Cloudflare-account

1. **KV**: Storage & Databases → KV → Create → naam `eigennet`. Kopieer de id naar `wrangler.toml`
   (`VUL_HIER_DE_KV_ID_IN`).
2. **D1**: Storage & Databases → D1 → Create → naam `eigennet`. Kopieer de id naar `wrangler.toml`
   (`VUL_HIER_DE_D1_ID_IN`).
3. **Worker**: Workers & Pages → Create → Import a repository → kies deze repo. Build command leeg laten.
4. **Secrets** (Worker → Settings → Variables and Secrets, type Secret):
   - `AUTH_SECRET`: een lange willekeurige tekst. Zonder deze staat de login uit en is alles open.
   - `ADMIN_WACHTWOORD`: wachtwoord voor `/admin`.
5. Open `https://eigennet.<jouw-subdomein>.workers.dev/admin`, log in met het beheerderswachtwoord.
6. **Netten overnemen**: vul bij "Netten overnemen uit Lijnkijker" het adres van Lijnkijker in en klik
   *Netten overnemen*. Krijg je de melding over de Benelux, vul dan ook de testsleutel (`TESTKEY`) van
   Lijnkijker in.
7. Maak je eigen account aan via `/login` → *Account aanvragen*, keur het goed in `/admin` en vink
   **Bouwer** aan.
8. Zet in Lijnkijker de variabele `EIGENNET_URL` op het nieuwe adres. Vanaf dan sturen de oude links
   (`/eigennet`, `/haltebord`, `/eigenkaart` en de boordcomputer met `?eigen=`) door naar hier,
   zodat de QR-codes aan de haltes blijven werken.

## Lokaal

```bash
npm install
printf 'AUTH_SECRET=test\nADMIN_WACHTWOORD=beheer\nGEO_OPEN=1\n' > .dev.vars
npx wrangler dev
```
