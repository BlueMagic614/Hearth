# Hearth

A private household finance assistant for the Green household: zero-based budget with an editable category tree, bills and paydays on a calendar, student-loan payoff planning with interest, and one-time income. Runs as one installable web app on the PC and both phones.

**Status:** Phase 1 (foundation) in progress. Kemba bank sync arrives in Phase 2. See the Technical Plan & Roadmap doc for the full plan.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Pure money logic shared by server and app: integer-cent money, dates, loan payoff (snowball/avalanche, lumps, raises), category tree, schedules, balance projection. Fully unit-tested. |
| `apps/server` | Fastify API + PostgreSQL. Uses PGlite (Postgres in WebAssembly) locally and in tests, real Postgres in production via `DATABASE_URL`. Serves the built web app. |
| `apps/web` | React + TypeScript app (Vite), installable as a PWA. |

## Run it locally

Requires Node 20+.

```bash
npm install
npm run build          # builds the web app into apps/web/dist
npm start -w @hearth/server
```

Open http://localhost:8787. On first start the server creates the database and seeds the household (pay, the 21 bills, categories with starter amounts, student loans, goals, February income).

Starter sign-ins (you'll be asked to choose a new password the first time):

- `jason@hearth.local`
- `renee@hearth.local`

Starter password: `hearth-dev-password` (override with `HEARTH_DEV_PASSWORD`).

For live-reloading development, run `npm run dev` (server on :8787, app on :5173 with `/api` proxied).

## Deploy (Render)

`render.yaml` describes the whole setup: an always-on Starter web service and a Basic Postgres database, both in Render's Ohio region.

1. Sign in to Render with GitHub and allow it to see `BlueMagic614/Hearth`.
2. **New → Blueprint**, pick the repo, and approve the two resources.
3. When the deploy finishes, open the `hearth` service → **Environment** and copy `HEARTH_INITIAL_PASSWORD`.
4. Visit the service URL (`https://hearth-xxxx.onrender.com`), sign in as `jason@hearth.local` with that password, and choose your own. Renee does the same with `renee@hearth.local`.
5. On each phone, open the URL and choose **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: menu → Install app).

Every push to `main` redeploys automatically. The database is only reachable from the web service.

## Tests

```bash
npm test               # core + server
npm run typecheck
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. If unset, a local PGlite database is used. |
| `HEARTH_DATA_DIR` | Where the local PGlite database lives (default `apps/server/.data/pglite`). |
| `HEARTH_DEV_PASSWORD` | Starter password for seeded users. Not set in production; users must be given passwords. |
| `PORT` | Server port (default 8787). |
| `NODE_ENV=production` | Secure cookies; no starter password. |

## Money rules

- All amounts are integer cents. Transactions store money out as negative.
- Only leaf categories carry planned money; parents roll up. A category that gains children hands its money (and transactions) to a "General" subcategory so nothing is lost.
- Planned amounts carry forward month to month until changed.
- Deleting a category archives it and can be undone.
