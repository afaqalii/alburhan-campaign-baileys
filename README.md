# Al Burhan Messenger — Baileys Edition

Multi-user WhatsApp bulk messaging. No Chromium. No Puppeteer.
Each browser tab is a completely independent WhatsApp session.

## Why Baileys over whatsapp-web.js

| | whatsapp-web.js | Baileys |
|---|---|---|
| RAM per user | ~200 MB (Chromium) | ~5 MB (WebSocket) |
| Users on 1GB server | 3–4 max | 50–100+ |
| Chromium needed | Yes | No |
| QR scan experience | Same | Same |

## Quick Start

```bash
npm install
npm start
# → http://localhost:3000
```

## How multi-user works

- Each browser **tab** gets a unique `sessionId` stored in `sessionStorage`
- `sessionStorage` is isolated per tab and clears when the tab closes
- The server maintains a separate Baileys socket per `sessionId`
- WhatsApp auth credentials are saved in `.wa_sessions/<sessionId>/`
- Users reconnect automatically on page refresh without re-scanning QR

## CSV Format

```csv
name,phone,group
Ahmad Hassan,+923001234567,Customers
Fatima Noor,+923331234567,VIP
```

- `phone` column required (with country code)
- Column names case-insensitive — `Phone`, `PHONE`, `mobile`, `number` all work
- CSV is parsed in memory and never written to disk

## Deployment on DigitalOcean

```bash
# No Chromium needed — just Node.js
npm install
PUPPETEER_EXECUTABLE_PATH is NOT needed

pm2 start server.js --name alburhan-messenger
ufw allow 3000
```

## Environment Variables

```
PORT=3000   (default)
```

No other env vars needed. No Chromium path. No Puppeteer config.
# alburhan-campaign-baileys
