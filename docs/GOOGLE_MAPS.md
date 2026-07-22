# Google Maps setup (Crew map)

The admin **Crew map** plots punch GPS on Google Maps. It needs a Maps JavaScript API key on the server.

## 1. Create / pick a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Top bar → project picker → **New Project** (or select the same project you use for Google admin sign-in).
3. Name it something like `Constructors911 Field` → **Create**.

## 2. Enable the Maps JavaScript API

1. Go to **APIs & Services → Library**.
2. Search for **Maps JavaScript API**.
3. Open it → **Enable**.

(You do **not** need Places, Directions, or Geocoding for this first map.)

## 3. Create an API key

1. **APIs & Services → Credentials → Create credentials → API key**.
2. Copy the key.

## 4. Restrict the key (important)

Open the key → **Edit**:

**Application restrictions**

- Choose **HTTP referrers (web sites)**.
- Add the URLs you actually use, for example:
  - `http://localhost:5173/*` (Vite dev)
  - `http://127.0.0.1:5173/*`
  - `https://your-production-domain.com/*`

**API restrictions**

- Restrict key → select only **Maps JavaScript API**.

Save.

## 5. Put the key on the server

Set an environment variable (never commit it to git):

```bash
GOOGLE_MAPS_API_KEY=AIza...your-key...
```

| Where | How |
|---|---|
| Local server | Put it in the shell env before `npm start`, or a local `.env` loader if you use one |
| Vercel | Project → Settings → Environment Variables → add `GOOGLE_MAPS_API_KEY` |

Restart the server after setting it.

## 6. Verify

1. Sign in at `/#/admin` (Google allowlist or admin key).
2. Open **Crew map**.
3. You should see the map canvas (empty until someone clocks in with GPS).

If you see “Google Maps API key not configured”, the env var is missing from the process that serves `/api`.

If the map area is blank / console shows `ApiNotActivatedMapError` or `RefererNotAllowedMapError`, re-check steps 2 and 4.

## How the app uses the key

- Only authenticated admins can fetch it: `GET /api/admin/map/config`.
- The browser loads `https://maps.googleapis.com/maps/api/js?key=…` once.
- Crew never see this key path; the field tabs do not load Maps.

## Billing note

Google requires a billing account on the project even for the free monthly Maps credit. Set a budget alert in **Billing → Budgets & alerts** so a bad key leak can’t run up a surprise bill. Referrer + API restrictions above are the main protection.
