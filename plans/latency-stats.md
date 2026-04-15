# Audio Output Latency Histogram

## Goal
Track `AudioContext.outputLatency` from users, aggregate into a distribution, display as a histogram (latency → count) on the dashboard. No time dimension, no per-user time series — just "which latency values have been seen, and how often".

## 1. Bucketing — the "merge 20.1 and 20.2" question
`outputLatency` is in **seconds** — 20.1 ms arrives as `0.0201`.

Two approaches:
- **A. Bucket on ingest (recommended).** Round the value to a fixed bucket on the server, increment a counter. Lossy but compact, fast, no re-aggregation needed.
- **B. Store raw, bucket on display.** Append every observation to a log. Dashboard re-buckets at render time. Flexible but bigger file, heavier load.

**Decision: A with 1 ms buckets.** Fine enough to distinguish 20 ms vs 30 ms hardware, coarse enough to collapse 20.1 and 20.2. If the shape later looks too smooth/chunky, change the bucket width server-side.

Bucket key formula:
```
ms = round(latency_seconds * 1000)
```
- `0.0201 → 20`
- `0.0202 → 20`
- `0.0205 → 21`

Storage shape:
```json
{ "20": 142, "21": 87, "22": 54, ... }
```
Key = bucket in ms, value = count.

If sub-ms precision is needed later: `round(latency_seconds * 2000) / 2` for 0.5 ms buckets.

## 2. Client
**Where to hook in**
Wherever `AudioContext` is constructed — probably one place in the engine / `StudioService`. Confirm by grepping `new AudioContext`.

**Detection logic**
```ts
let lastReported: number | undefined
const reportLatency = () => {
    const ms = Math.round(ctx.outputLatency * 1000)
    if (ms === 0 || ms === lastReported) return
    lastReported = ms
    navigator.sendBeacon(
        "https://api.opendaw.studio/latency.php",
        JSON.stringify({latency: ms})
    )
}
ctx.addEventListener("statechange", reportLatency)
reportLatency()
```

- **`navigator.sendBeacon`**: fire-and-forget, survives page unload, no CORS preflight for simple content types, no error handling needed.
- **In-memory `lastReported`**: avoids spamming on rapid `statechange` bursts within one page load.
- **Skip `ms === 0`**: AudioContext not warmed up yet.

**When does outputLatency change?**
- Initial startup (most common — one report per load).
- After `ctx.close()` + recreation.
- Device hot-swap (rare; most browsers don't reflect this).

A short poll (every 10 s) could catch device swaps, but `statechange` + initial report covers 99% of cases. Start without polling; add if needed.

## 3. Server (PHP)
Single endpoint: `POST https://api.opendaw.studio/latency.php`.

```php
<?php
header("Access-Control-Allow-Origin: *");
$body = json_decode(file_get_contents("php://input"), true);
$ms = intval($body["latency"] ?? 0);
if ($ms < 1 || $ms > 5000) { http_response_code(400); exit; }

$file = "/var/www/api/latency.json";
$fp = fopen($file, "c+");
flock($fp, LOCK_EX);
$raw = stream_get_contents($fp);
$data = $raw ? json_decode($raw, true) : [];
$key = strval($ms);
$data[$key] = ($data[$key] ?? 0) + 1;
rewind($fp);
ftruncate($fp, 0);
fwrite($fp, json_encode($data));
flock($fp, LOCK_UN);
fclose($fp);
http_response_code(204);
```

Notes:
- `flock` around read-modify-write — concurrent POSTs don't clobber each other.
- `intval` + range check `[1, 5000]` — reject 0 (uninitialised), giant outliers (broken hardware), and non-numeric input.
- Lives next to `status.php` on the same host.

**GET endpoint**: serve `latency.json` statically (no PHP needed for reads). Dashboard fetches it directly.

## 4. Dashboard
**Data fetcher** — add to `stats/data.ts`:
```ts
export type LatencyStats = ReadonlyArray<readonly [ms: number, count: number]>

export const fetchLatencyStats = async (): Promise<LatencyStats> => {
    const data = await fetchJson<Record<string, number>>(
        "https://api.opendaw.studio/latency.json", {mode: "cors"})
    return Object.entries(data)
        .map(([key, count]) => [parseInt(key, 10), count] as const)
        .sort(([a], [b]) => a - b)
}
```

**Chart** — the existing `BarChart` in `charts.tsx` takes `ObservableValue<DailySeries>` where `DailySeries = [date, value][]`. The latency data is `[ms, count][]` — structurally identical. Two options:
1. **Reuse BarChart** by stringifying the ms as the "date" (label). Axis labels work because we control the formatter.
2. **Add a `gapless?: boolean` prop** for a proper histogram look (contiguous bars, no gap between slots). Small modification.

Recommended: (2) — a histogram should look like a histogram.

**Card placement** — new full-width card inside `StatsBody`:
```tsx
<div className="span-12">
    <Card title="Audio Output Latency" accent={<span>1 ms buckets · all users</span>} className="compact">
        <BarChart lifecycle={lifecycle} series={latencySeries} color={Colors.yellow.toString()} gapless/>
    </Card>
</div>
```

Or outside StatsBody (own Await) — the latency data is independent of the rooms/users data, no reason to gate it on that.

## 5. Deduplication
Key question: does **every ping** count, or do we only count each user once?

| Option | Description | Pros | Cons |
|---|---|---|---|
| A | Every ping = 1 | Simplest | Heavy users (many reloads) skew counts |
| B | Once per session | `sessionStorage` flag | Reset per tab session |
| C | Once per user ever | `localStorage` flag | First report only — later device changes lost |
| **D** | **Once per (user, latency) pair** | `localStorage["latencies-reported"] = [20, 22]` | Each user contributes each distinct value exactly once |

**Recommendation: D.** Truest distribution, almost as simple as B on the client. Implementation:

```ts
const KEY = "reported-latencies"
const reportLatency = () => {
    const ms = Math.round(ctx.outputLatency * 1000)
    if (ms === 0) return
    const reported: number[] = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    if (reported.includes(ms)) return
    reported.push(ms)
    localStorage.setItem(KEY, JSON.stringify(reported))
    navigator.sendBeacon(
        "https://api.opendaw.studio/latency.php",
        JSON.stringify({latency: ms})
    )
}
```

Server stays the same — it just counts. Dedup is purely client-side.

## 6. Open questions
1. **Bucket width** — 1 ms? Or 0.5 ms / 2 ms? *Recommend 1 ms.*
2. **Dedup strategy** — A / B / C / D? *Recommend D.*
3. **Hook location** — grep for `new AudioContext`; confirm the canonical creation site.
4. **Server path** — is `/var/www/api/latency.json` the right filesystem path, or is there an existing stats directory convention?
5. **CORS** — `Access-Control-Allow-Origin: *` or restrict to opendaw.studio?
6. **Histogram placement** — full-width card in `StatsBody`, or standalone between tiles and charts?
7. **Color** — yellow, green, purple? (I suggested yellow above because latency is neither good nor bad.)
8. **Outlier cap** — 5000 ms (5 s) server-side is very permissive. Tighter (e.g., 1000 ms) would reject even more broken hardware reports.

## 7. Implementation checklist (once decisions are locked in)
- [ ] Server: write `api.opendaw.studio/latency.php` (POST handler with flock).
- [ ] Server: ensure `latency.json` is readable at the corresponding GET URL.
- [ ] Client: find AudioContext creation site.
- [ ] Client: add `reportLatency()` helper + localStorage dedup.
- [ ] Client: wire into context `statechange` + initial call.
- [ ] Dashboard: `fetchLatencyStats()` in `data.ts`.
- [ ] Dashboard: add `gapless` prop to `BarChart` in `charts.tsx`.
- [ ] Dashboard: new card in `StatsBody` (or standalone Await).
- [ ] Verify: reload the app a few times, confirm the counter increments, histogram renders.
