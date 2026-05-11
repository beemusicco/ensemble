# Dashboard Performance Audit

## Scope

Repo: `~/projects/brainai-dashboard/`  
Stack: Express + React + Vite  
Primary DBs:

- `market.db` — 21 GB
- `orderbook.db` — 8.0 GB
- `paper_trades.db` — 121 MB

Known architectural constraint: backend uses synchronous `better-sqlite3`, so slow queries block the Node event loop.

## Executive Summary

The dashboard is slow because multiple layers amplify synchronous DB work:

1. `server/routes/sse.js` is implemented as per-client polling, not true push.
2. The frontend still has many independent pollers for the same `/api/crypto/*` endpoints.
3. Several hot `paper_positions` queries lack composite indexes and fall back to scans + temp B-trees.
4. A few expensive endpoints are genuinely slow or timing out.
5. Large JSON payloads are repeatedly sent without any visible response compression middleware.

The highest-leverage fix is to replace per-client SSE polling with one shared broadcaster and fan out one cached payload to all clients.

## Method

Completed:

- Source audit of backend routes, SSE, hooks, and crypto components
- `sqlite3` `PRAGMA index_list(...)`
- `sqlite3` `EXPLAIN QUERY PLAN` on representative hot queries
- Live curl timings from teammate for `/api/crypto/*`
- Payload-size review from live curl and direct response-shape estimation

Constraint:

- I could not reliably hit localhost from this sandbox, so the live curl numbers below come from teammate verification. Source audit and DB-plan validation were done locally.

## `/api/crypto/*` Inventory

GET routes found in `server/routes/crypto.js`:

- `/health`
- `/backtests`
- `/funding`
- `/cross-funding`
- `/research`
- `/whales`
- `/onchain`
- `/positioning`
- `/paper/orderbook`
- `/paper/candles`
- `/paper/market`
- `/paper/history`
- `/paper/equity`
- `/paper/positions`
- `/paper/signals`
- `/paper/strategies`
- `/paper/analytics`
- `/paper/performance`
- `/data-freshness`
- `/paper/daily-history`
- `/paper/exit-analytics`
- `/paper/risk`
- `/paper/pairs`
- `/paper/calibrations`
- `/paper/spreads`
- `/paper/discovery`
- `/paper/data-quality`
- `/paper/optimizer`
- `/paper/readiness`
- `/paper/regime`
- `/paper/mm`
- `/account`
- `/readiness`
- `/arbitrum`
- `/deposits`
- `/paper/observation`
- `/paper/regime-analysis`
- `/paper/config`
- `/options`
- `/shadow`
- `/sentiment`
- `/regime`
- `/paper/llm-decisions`
- `/paper/hypothesis-pipeline`

Write routes exist too, but were excluded from direct timing because they mutate state.

## Live Timing Findings

### Endpoints over 500 ms

- `/api/crypto/paper/readiness` — `1349 ms`, `3.7 KB`
- `/api/crypto/paper/data-quality` — timeout `>8s`
- `/api/crypto/health` — timeout `>8s`

Interpretation:

- `paper/readiness` is slow enough to create a visible UI stall on mount.
- `data-quality` and `health` are severe enough to treat as blocking defects.
- `health` is especially dangerous because SSE polls it every `30s`.

### Fast endpoints

- `paper/market` — `2 ms`, `18 KB`
- `paper/positions` — `16 ms`, `73 KB`
- `paper/signals` — `8 ms`, `12 KB`
- `paper/risk` — `8 ms`, `2.9 KB`
- `paper/history` — `7 ms`, `70 KB`
- `paper/candles` — `1.7 ms`, `16 KB`
- `paper/pairs` — `1 ms`
- `paper/regime-analysis` — `2 ms`
- `paper/mm` — `17 ms`, `24 KB`
- `paper/strategies` — `29 ms`, `85 KB`

Important nuance:

- Some routes are individually “fast” but still expensive in aggregate because they are large and/or repeatedly polled.

## Payload Size Findings

### Over 100 KB

- `/api/crypto/paper/discovery` — `197 KB`
- `/api/crypto/paper/performance` — `156 KB`
- `/api/crypto/paper/analytics` — `130 KB`

### 50-100 KB

- `/api/crypto/paper/equity` — `88 KB`
- `/api/crypto/paper/strategies` — `85 KB`
- `/api/crypto/paper/positions` — `73 KB`
- `/api/crypto/paper/history` — `70 KB`

### Why this matters

- `paper/positions` over SSE at `2s` is the biggest bandwidth repeater.
- `paper/history` is not huge per request, but 4 separate pollers make it effectively large.
- `analytics` and `performance` should be paginated or field-filtered server-side.

## SSE Audit

`server/routes/sse.js:11-15` frequencies:

- `market` — `1500 ms`
- `positions` — `2000 ms`
- `signals` — `5000 ms`
- `risk` — `10000 ms`
- `health` — `30000 ms`

`server/routes/sse.js:36-56` creates the main architectural bottleneck:

- every SSE client gets its own 5 timers
- every timer performs an internal `fetch()` back into the same Express app
- those routes run synchronous SQLite handlers

This multiplies work by connected tabs:

- `paper/positions` is `73 KB` every `2s`
- `paper/market` is `18 KB` every `1.5s`
- with 10 clients, positions alone is roughly `360 KB/s`

Observed SSE stats from teammate:

- 2 active connections during timing run

### Cache mismatch

`server/routes/crypto.js:997`

- `const MARKET_CACHE_TTL_MS = 1500`

`server/routes/crypto.js:1013`

- comment still says “cached 5s”

`server/routes/sse.js:11`

- market SSE interval is also `1500 ms`

This is poor alignment. In the worst case, each market tick lands on cache expiry and reruns the full market pipeline in `server/routes/crypto.js:1028-1119`.

That pipeline includes:

- latest prices or fallback to `prices`
- 1h change
- 24h change
- funding
- market overview / OI
- orderbook spread loop
- 24h volume

### Orderbook amplification

`server/routes/crypto.js:1099-1105`

- per market request does `bid` + `ask` lookup for each tracked WS coin
- roughly `25 coins x 2 queries = 50 indexed lookups` per request

This should be batched, not looped per asset on every market refresh.

## Index Review

### `market.db`

`prices`

- `idx_prices_ts`
- `idx_prices_asset_ts`

`candles`

- `idx_candles_ts`
- `idx_candles_asset_interval_ts`

`trades`

- `idx_trades_ts`
- `idx_trades_asset_ts`

### `paper_trades.db`

`paper_positions`

- `idx_pp_status`
- `idx_pp_strategy`

Critical gap: no composite indexes for hot access patterns like `status + exit_time` and `status + entry_time`.

## Query Plan Findings

### Good plan

`/api/crypto/paper/candles`  
`server/routes/crypto.js:976-980`

- query uses `WHERE asset=? AND interval=? ORDER BY ts_open DESC LIMIT ?`
- plan: `SEARCH candles USING INDEX idx_candles_asset_interval_ts`

### Expensive plans

`/api/crypto/paper/market` fallback latest price  
`server/routes/crypto.js:1033-1036`

- query: `SELECT asset, mid_price, ts FROM prices WHERE ts > ? GROUP BY asset HAVING ts = MAX(ts) ORDER BY mid_price DESC`
- plan: `SCAN prices USING INDEX idx_prices_asset_ts` + temp B-tree for order-by

`/api/crypto/paper/market` 1h / 24h change queries  
`server/routes/crypto.js:1052-1067`

- query shape groups `candles` by asset after time filtering
- plan: `SEARCH candles USING INDEX idx_candles_ts` + temp B-tree for group-by

`recentCount(...)` helper used in `/api/crypto/health`  
`server/routes/crypto.js:178-186`

- plan still scans `trades` in the subquery

`/api/crypto/paper/positions` closed positions  
`server/routes/crypto.js:1506-1509`

- query: `SELECT * FROM paper_positions WHERE status!='OPEN' ORDER BY exit_time DESC LIMIT ?`
- plan: full scan + temp B-tree for order-by

`/api/crypto/paper/history` summary  
`server/routes/crypto.js:1437-1439`

- query: `SELECT pnl_net FROM paper_positions WHERE ${where}`
- base case becomes `status != 'OPEN'`
- plan: full scan

This is especially wasteful because the route already fetched a limited result set, then separately scans all matching rows just to compute summary stats.

## Frontend Polling Audit

### Actual SSE consumers

- `src/pages/CryptoPage.jsx:151` → `useSSE('positions')`
- `src/components/crypto/MarketOverview.jsx:28` → `useSSE('market')`
- `src/components/crypto/TradeForm.jsx:57` → `useSSE('market')`
- `src/components/crypto/PriceChart.jsx:223` → `useSSE('market')`

Important:

- `useSSEWithFallback` exists at `src/hooks/useSSE.jsx:61`
- no component uses it
- `signals` and `risk` SSE channels currently have no consumers

### SSE re-render problem

`src/hooks/useSSE.jsx:33-39` and `:49-58`

- all channels live in one context object
- every channel update replaces the whole object
- consumers of one channel still re-render when any other channel changes

Example:

- `CryptoPage` uses `positions`
- `market` emits every `1500 ms`
- unrelated `market` updates still cause `positions` consumers to re-render

### Duplicate pollers

`cryptoPaperHistory`

- `src/components/crypto/BottomPanel.jsx:57,63` at `15000 ms`
- `src/components/crypto/BottomPanel.jsx:233,236` at `15000 ms`
- `src/components/crypto/TradeHistoryPanel.jsx:63,66` at `30000 ms`
- `src/components/crypto/PositionHistory.jsx:12,13` at `30000 ms`

`cryptoPaperRisk`

- `src/components/crypto/RiskPanel.jsx:41-43` at `10000 ms`
- `src/components/crypto/TradeForm.jsx:69,77` at `10000 ms`
- `src/components/crypto/PaperTrading.jsx:39,49`

`cryptoPaperPositions`

- `src/components/crypto/AccountPanel.jsx:187,218-219`
- `src/components/crypto/PriceChart.jsx:232`
- `src/components/crypto/OptionsTab.jsx:179,185`
- `src/components/crypto/PaperTrading.jsx:37,49`

`cryptoPaperStrategies`

- `src/components/crypto/TradeForm.jsx:51`
- `src/components/crypto/StrategiesTab.jsx:229,231` at `10000 ms`
- `src/components/crypto/AccountPanel.jsx:191`

### Aggressive intervals

Intervals `<= 10s` found in:

- `MarketOverview` `5s`
- `RecentSignals` `5s`
- `LogsPage` `5s`
- `SMSPage` `5s`
- `RiskPanel` `10s`
- `TradeForm` risk loop `10s`
- `MarketMakerPanel` `10s`
- `DeploymentMonitor` `10s`
- `StrategiesTab` `10s`
- `PriceChart` `10s`
- `ProposalList` `10s`

### Missing or inconsistent `document.hidden` guards

- `src/components/crypto/MarketOverview.jsx:40`
- `src/components/crypto/RiskPanel.jsx:43`
- `src/components/crypto/ShadowModePanel.jsx:29`
- `src/components/crypto/RegimePanel.jsx:21`
- `src/components/crypto/TradeForm.jsx:77`
- `src/components/crypto/DailyPnlPanel.jsx:169`
- `src/pages/LogsPage.jsx:35`
- `src/pages/SMSPage.jsx:40`

## Cache Layer Review

Present caches:

- `_countCache` — `60s`
- `_healthCache` — `300s`
- `_marketCache` — `1500 ms`
- `hlCache` — `30s`
- `arbCache` — `30s`
- tracked coins cache — `60s`

Problems:

1. Hot paper endpoints such as `history`, `positions`, `strategies`, and `risk` are uncached despite repeated polling.
2. `market` cache TTL is too short for the current SSE design.
3. Comments and real TTL values diverge.
4. `health` cold-cache path is still severe enough to timeout.

## Compression Review

`server/index.js` does not show `compression` middleware.

Given these payload sizes:

- `discovery` `197 KB`
- `performance` `156 KB`
- `analytics` `130 KB`
- `positions` `73 KB`

enabling gzip or brotli would be a straightforward bandwidth reduction, though it does not solve the event-loop blocking root cause.

## Top 5 Fixes

### 1. Replace per-client SSE polling with one shared broadcaster

Priority: critical

- one timer per channel globally
- fetch once, fan out to all `res` clients
- no internal HTTP back into the same process for each client

Expected impact:

- largest immediate reduction in sync DB pressure

### 2. Raise `MARKET_CACHE_TTL_MS` to `3000-5000 ms` and fix stale comments

Priority: critical

- current `1500 ms` TTL aligns badly with `1500 ms` SSE interval
- use a TTL that guarantees most market ticks are cache hits

Expected impact:

- fewer full market pipeline executions

### 3. Add composite indexes for `paper_positions`

Priority: high

Recommended first indexes:

- `(status, exit_time DESC)`
- `(status, entry_time DESC)`
- `(strategy, status, entry_time DESC)`

Expected impact:

- removes scans and temp B-trees from hot history / positions / strategies paths

### 4. Consolidate duplicate polling and route more consumers through SSE/shared client cache

Priority: high

- dedupe 4 history pollers
- dedupe 3 risk pollers
- add SSE consumers for existing `signals` and `risk` channels
- consider shared state for `history` and `strategies`

Expected impact:

- lower request count and less redundant rendering

### 5. Reduce large payloads with pagination / field filtering / compression

Priority: high

- paginate `analytics`, `performance`, and `discovery`
- avoid sending full objects when only summaries are needed
- enable compression middleware

Expected impact:

- lower bandwidth and parse cost

## Secondary Fixes

- batch orderbook spread retrieval instead of 50 point queries per market refresh
- raise candle polling from `10s` to `30-60s`
- add `document.hidden` guards consistently
- compute `paper/history` summary from cached aggregates or precomputed stats instead of full rescans
- split SSE state per channel or use `useSyncExternalStore` selectors

## Concrete Hotspots

- `server/routes/sse.js:36-56`
- `server/routes/crypto.js:1028-1119`
- `server/routes/crypto.js:1403-1471`
- `server/routes/crypto.js:1497-1658`
- `server/routes/crypto.js:997`
- `src/hooks/useSSE.jsx:33-39`
- `src/components/crypto/BottomPanel.jsx:57-63`
- `src/components/crypto/BottomPanel.jsx:233-236`
- `src/components/crypto/RiskPanel.jsx:41-43`
- `src/components/crypto/StrategiesTab.jsx:229-231`
- `src/components/crypto/PriceChart.jsx:238`

## Bottom Line

The dashboard is slow because synchronous DB work is multiplied by both backend and frontend design:

- per-client SSE polling
- duplicate React polling loops
- scan-heavy `paper_positions` queries
- short or missing caches on hot paths
- repeated large payloads

If only one change ships, make SSE shared-broadcast. If two changes ship, add the `paper_positions` composite indexes next.
