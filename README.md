# Excalidraw Workspace - りょういきてんかい (Domain expansion)

A small, self-hosted Excalidraw workspace for keeping many projects and pages in one place.

The sidebar is intentionally simple: create projects, add pages, rename them, delete them, and drag them into a new order. Each page keeps its drawing, images, and last pan/zoom position on the server.

![infinite canvas: infinte pages](./banner.gif)

## What it includes

- Excalidraw in a project/page layout.
- Persistent saves for drawings and embedded files.
- A collapsible, hand-drawn-style sidebar.
- Queued saves so fast drawing does not create a pile of requests.
- Images uploaded once instead of being resent with every drawing save.
- PostgreSQL for a VPS install.
- SQLite for a simple local install.
- Secure, long-lived login cookies and basic per-IP throttling.
- No external account or third-party service is required.

https://github.com/user-attachments/assets/4c08289f-adf3-4c8a-b282-27a0c0085528

## Run locally with SQLite

This is the easiest way to try the project. Node.js 22 or newer is recommended.

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Then open `http://localhost:3000`.

The SQLite database is created at `./data/draw.sqlite3`. The `data/` directory is the important thing to back up.

## Run with PostgreSQL

For a VPS, use the included Compose file:

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, DRAW_PASSWORD, and SESSION_SECRET in .env.
docker compose up -d --build
```

The PostgreSQL data lives in the `draw_db` Docker volume. Put the app behind HTTPS before exposing it publicly. Caddy, Nginx, or a managed reverse proxy all work.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DRAW_PASSWORD` | Password for the private workspace. |
| `SESSION_SECRET` | Random secret used to sign the login cookie. |
| `STORAGE_BACKEND` | `postgres` or `sqlite`. If omitted, PostgreSQL is selected when `DATABASE_URL` exists; otherwise SQLite is selected. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `SQLITE_PATH` | SQLite file path. Defaults to `./data/draw.sqlite3`. |
| `PORT` | HTTP port. Defaults to `3000`. |

Generate secrets with:

```bash
openssl rand -base64 32
```

## Storage choices

The HTTP routes use the small adapter in [`storage.mjs`](./storage.mjs), so the rest of the app does not care which database is underneath.

- SQLite is good for one machine, a personal server, or development.
- PostgreSQL is better for a VPS, automated backups, and future horizontal scaling.
- Switching backends means exporting/importing the database; it does not require changing the UI.

Images are stored in a separate `page_files` table. Normal drawing updates are capped at 8 MB; a single image upload can be up to 64 MB. The browser queues saves and sends only the newest pending scene update.

## Security notes

The app limits password attempts to 10 per IP every 15 minutes and authenticated API traffic to 240 requests per IP per minute. These are application safeguards, not a replacement for edge DDoS protection. For a public deployment, put the domain behind Cloudflare or another WAF and use HTTPS with a strict origin certificate.

The login cookie is HttpOnly, Secure, SameSite=Lax, and valid for one year. Clearing browser site data logs the browser out; it does not delete the drawings.

## Backups

Back up the PostgreSQL volume or database dump for VPS installs. For SQLite, back up the SQLite file and its `-wal` file while the app is stopped, or use SQLite’s backup tooling. Keep at least one copy outside the VPS.

## Development

```bash
npm install
npm run build
npm start
```

The project deliberately keeps the server small and dependency-light. Pull requests should keep storage-specific SQL inside `storage.mjs` and keep UI behavior in `src.jsx`.

## License

MIT. See [`LICENSE`](./LICENSE).
