# rekt on rokkasa.com — nginx reverse proxy

The BTC data viewer (`rekt-web` service) is exposed publicly at
**https://rokkasa.com/rekt/**. This documents the nginx setup that makes it
work, including the non-obvious part that cost real debugging time.

## Services on pi5

| systemd unit | role | port |
|---|---|---|
| `rekt-receiver.service` | captures odds+spot → Postgres (+ JSONL) | — |
| `rekt-web.service` | the viewer (Express + Chart.js) | `localhost:8080` |

Both `Restart=always` and enabled on boot. Postgres (`rekt` db, `pi` role,
peer auth over unix socket, port **9043**) is the backing store.

## The nginx location (apply to **both** server blocks)

```nginx
# rekt — Polymarket BTC data viewer (reverse proxy to rekt-web:8080)
location = /rekt { return 301 /rekt/; }
location /rekt/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Add it **before** the `# Main site` `location / { ... }` in each server block.

## ⚠️ The gotcha that blocked this for ~1h

`/etc/nginx/sites-enabled/default` has **two** `server { }` blocks:

1. `listen 80 default_server` — serves most traffic
2. `listen 2284; server_name rokkasa.com` — the "documented" external entrypoint

The Cloudflare Worker → `pind.mooo.com:2284` architecture note
(`~/configs/nginx/rokkasa-unified.md`) describes port 2284 as the external
entry. **In practice the router maps external :2284 → pi5's port 80**, so
external requests are served by the **port-80 block**, not the 2284 block.

- `localhost:2284/rekt/` → 200 (matched the 2284 block, where I first added it)
- `https://rokkasa.com/rekt/` → 404 (served by the port-80 block, which lacked it)

### How it was diagnosed

A marker header (`add_header X-Rokkasa-Root hit;`) added to `location /`
proved external `/rekt/` 404s carried that header → the catch-all `location /`
was matching `/rekt/` before my `location /rekt/` could. That only happens
when the request lands in a server block *without* the `/rekt/` location —
i.e., the port-80 block.

### Fix

Put the `/rekt/` location in **both** server blocks. It now works regardless
of which block answers.

## Path-portability of the viewer

`src/web/index.ts` uses **relative** fetch URLs (`api/overview`, not
`/api/overview`) so the dashboard works behind the `/rekt/` prefix without
clashing with Immich's `/api/` route. Keep fetches relative when editing.

## Public exposure note

rokkasa.com is world-reachable via Cloudflare. The viewer exposes only
market data (BTC price, Polymarket odds, DB row counts) — **no secrets,
wallets, or creds ever touch it.** If gating is ever wanted, add
`auth_basic` to the `/rekt/` location.

## Deploy / verify

```bash
ssh pi5 'systemctl is-active rekt-receiver rekt-web'
ssh pi5 'curl -s localhost:8080/api/overview'          # viewer → DB
curl -s -o /dev/null -w "%{http_code}\n" https://rokkasa.com/rekt/   # expect 200
```
