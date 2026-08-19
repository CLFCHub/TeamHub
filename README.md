# CLFC Hub

A React/Vite frontend with a Cloudflare Worker + D1 backend.

## Features

- Four grade landing screen: League, Reserves, Colts, Thirds.
- Admin panel protected by a server-side passcode.
- Mock 22-player roster per grade.
- Clear roster.
- PlayHQ roster import through the Cloudflare Worker.
- PlayHQ response objects are preserved and enriched with the member's 4-digit `pin`.
- PINs are looked up from the D1 `members` table, preferring PlayHQ UID and falling back to normalized name.
- PlayHQ credentials are stored as Worker secrets, not in frontend code.
- D1 database stores roster data and is ready for a future master member list.

## 1. Frontend

```bash
npm install
npm run dev
```

For local development with a Worker, set:

```bash
VITE_WORKER_URL=http://localhost:8787
```

## 2. Cloudflare D1

From the `worker` directory:

```bash
npx wrangler d1 create clfchub
```

Copy the returned database ID into `worker/wrangler.toml`.

Then:

```bash
npx wrangler d1 execute clfchub --remote --file=schema.sql
```

## 3. Worker secrets

Never commit the PlayHQ API key or admin passcode.

```bash
npx wrangler secret put PLAYHQ_API_KEY
npx wrangler secret put ADMIN_PASSCODE
```

The organisation ID is already a non-secret Worker variable.

## 4. Deploy Worker

```bash
cd worker
npm install
npm run deploy
```

## 5. Connect frontend

Set `VITE_WORKER_URL` to the deployed Worker URL when building the frontend.

For Cloudflare Pages, add it as an environment variable.

## Important

The PlayHQ API key supplied for the prototype should be rotated if it is a real production credential, because it has been exposed in chat. The key is deliberately NOT written anywhere in this repository.

## D1 member PIN matching

The next database table can hold the club's master member list:

```sql
CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  playhq_uid TEXT UNIQUE,
  pin TEXT
);
```

When PlayHQ returns a roster, the Worker can match `playhq_uid` against `members.playhq_uid` and attach the corresponding 4-digit PIN to each player.