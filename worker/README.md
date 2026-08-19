# CLFC Hub Cloudflare Worker

This Worker is the secure backend for the CLFC Hub frontend.

It owns:
- PlayHQ API credentials
- admin authentication
- D1 roster storage
- mock roster creation
- PlayHQ roster retrieval

Do not put secrets in `wrangler.toml`, frontend code, GitHub, or the browser.

## Routes

- `GET /api/admin/status`
- `POST /api/admin/login`
- `POST /api/admin/mock`
- `POST /api/admin/clear`
- `GET /api/roster/:grade`
- `POST /api/roster/:grade/playhq`
