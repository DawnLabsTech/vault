# Frontend Dashboard

Internal monitoring UI for the Dawn Vault bot.

## Purpose

- Show the live portfolio split between the base layer and alpha layer.
- Make the current operating stance explicit: `Multiply` is primary, `Lending` is supplementary, `DN` is conditional.
- Surface the health, risk, and capacity signals that drive capital allocation.

## Runtime Model

- The frontend is a Next.js app that reads bot data through `/api/proxy/*`.
- The proxy forwards requests to the bot API and can attach auth on both sides.
- A zero-allocation alpha layer is a valid state. When funding is weak, the dashboard should read as "standby", not "broken".

## Local Development

```bash
cd frontend
npm install
PORT=4001 npm run dev
```

The frontend expects the bot API to be reachable at `http://localhost:3000` unless overridden.

Relevant environment variables:

- `BOT_API_URL`: upstream bot API base URL. Default: `http://localhost:3000`
- `BOT_API_TOKEN`: bearer token sent from the frontend proxy to the bot API. In production this should usually match `API_AUTH_TOKEN`.
- `FRONTEND_API_SECRET`: optional dashboard/proxy protection secret. When set, the frontend requires Basic auth (`vault:<secret>`) or `Authorization: Bearer <secret>`.

## Security Notes

- `/api/proxy/*` forwards only a fixed allowlist of bot endpoints.
- Chat requests forward client IP context so the bot can enforce per-client rate limits.
- Funding-rate history is fetched through the local `/api/fr-history` route instead of directly from the browser to Binance.

## Main Views

- `Bot / Portfolio / Performance`: top-line operating status and NAV
- `Signals & Allocation`: funding gate plus current base/alpha capital mix
- `Base Layer`: active Multiply position and supplementary lending sleeve
- `Alpha Layer`: dawnSOL + perp hedge when active, standby otherwise
- `PnL / Events`: realized performance history and operational audit trail

## Bot API Endpoints Used

- `/api/status`
- `/api/apys`
- `/api/multiply`
- `/api/fr`
- `/api/pnl`
- `/api/events`
