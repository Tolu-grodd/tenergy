# Solar Monitor setup

Needs nothing at home and no credit card. Three pieces:

- **Firebase** (`home-energy-n0u5x`, free Spark plan): hosts `public/` and handles Google sign-in. No Firestore, no functions.
- **Cloudflare Worker** (`worker/`, free plan): the always-on part. Calls Tuya (the secret stays here), records history in D1, runs the daily fridge cutoff on a 2-minute cron, and serves the dashboard's data. It verifies the Firebase sign-in token and only accepts the owner's Google account.
- **Home agent** (`agent/`, optional): only for the Router tab. Reports router health from inside the house. Run with `npm run agent` (needs `INGEST_URL` = the Worker's `/api/router` and `INGEST_KEY` in `agent/.env`).

## One-time steps
1. Firebase console > Authentication > Get started > enable the Google provider.
2. Free Cloudflare account (no card), then `npx wrangler login` and approve once.
3. From the project folder:
   ```
   npx wrangler d1 create home-energy            # copy the database_id into worker/wrangler.toml
   npx wrangler d1 execute home-energy --remote --file=worker/schema.sql --config worker/wrangler.toml
   npx wrangler secret put TUYA_ACCESS_ID --config worker/wrangler.toml
   npx wrangler secret put TUYA_ACCESS_SECRET --config worker/wrangler.toml
   npx wrangler secret put INGEST_KEY --config worker/wrangler.toml
   npm run worker:deploy                          # prints the workers.dev URL
   ```
4. Put that URL in `public/firebase-config.js` (`API_URL`), then `firebase deploy --only hosting`.

## Local testing
`npm run worker:dev` runs the Worker on :8799 with auth off (secrets in `worker/.dev.vars`, git-ignored). Serve `public/` on localhost and open it with `?api=http://127.0.0.1:8799`.

## Other
- `npm run devices` lists the Tuya plugs with online state and live readings (`.env` holds the Tuya keys).
- Secrets, all git-ignored: `.env`, `agent/.env`, `worker/.dev.vars`.
