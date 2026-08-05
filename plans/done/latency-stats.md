# Audio Output Latency Histogram

## Goal
Track `AudioContext.outputLatency` from users, aggregate into a distribution, display as a histogram (latency → count) on the dashboard. No time dimension, no per-user time series — just "which latency values have been seen, and how often".

## 1. Bucketing — the "merge 20.1 and 20.2" question
`outputLatency` is in **seconds** — 20.1 ms arrives as `0.0201`.

Two approaches:
- **A. Bucket on ingest (recommended).** Round the value to a fixed bucket on the server, increment a counter. Lossy but compact, fast, no re-aggregation needed.
- **B. Store raw, bucket on display.** Append every observation to a log. Dashboard re-buckets at render time. Flexible but bigger file, heavier load.

**Decision: A with 1 ms buckets, capped at 500 ms.**

Bucket key formula:
```
raw = outputLatency              // seconds, or undefined
ms  = isDefined(raw) ? min(500, round(raw * 1000)) : -1
```
- `0.0201 → 20`, `0.0202 → 20`, `0.0205 → 21`
- `0.8 → 500` (capped)
- `undefined → -1` (browser doesn't support `outputLatency`)

Values above 500 ms are **capped to 500** (not rejected) so they still count — the 500 bucket becomes "500+" on the chart.

Value `-1` means `outputLatency` was `undefined` — displayed as "N/A" on the chart axis.

Storage shape:
```json
{ "-1": 8, "20": 142, "21": 87, "500": 3 }
```
Key = bucket in ms (or -1 for undefined), value = count.

## 2. Client
**Where to hook in**
Wherever `AudioContext` is constructed — probably one place in the engine / `StudioService`. Confirm by grepping `new AudioContext`.

**Detection logic**
```ts
const reportLatency = (ctx: AudioContext) => {
    const raw = ctx.outputLatency
    const ms = isDefined(raw) ? Math.min(500, Math.round(raw * 1000)) : -1
    const KEY = "reported-latencies"
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

- **`navigator.sendBeacon`**: fire-and-forget, survives page unload, no CORS preflight.
- **localStorage dedup**: each user reports each distinct ms value at most once (including `-1` for undefined).
- **`-1` for undefined**: some browsers (Safari) don't expose `outputLatency`. These reports are collected and shown as "N/A" on the histogram — important to see how many users lack this API.
- **Cap at 500 ms**: anything above is capped TO 500 (not dropped). The 500 bucket shows "500+" on the chart.

**When to call `reportLatency`:**
- On AudioContext creation (initial startup).
- On `statechange` event.
- On audio output device change — subscribe to `navigator.mediaDevices.addEventListener("devicechange", ...)` and re-measure after the context settles.

**Device change detection:**
```ts
navigator.mediaDevices.addEventListener("devicechange", () => {
    // outputLatency may take a moment to reflect the new device
    setTimeout(() => reportLatency(ctx), 1000)
})
```

## 3. Server (PHP)
Single endpoint: `POST https://api.opendaw.studio/latency.php`.

```php
<?php
$origin = $_SERVER["HTTP_ORIGIN"] ?? "";
$allowed = ["https://opendaw.studio", "http://localhost"];
$match = false;
foreach ($allowed as $prefix) {
    if (str_starts_with($origin, $prefix)) { $match = true; break; }
}
if (!$match) { http_response_code(403); exit; }
header("Access-Control-Allow-Origin: $origin");

$body = json_decode(file_get_contents("php://input"), true);
$ms = intval($body["latency"] ?? 0);
if ($ms < -1 || $ms > 500) { http_response_code(400); exit; }

$file = __DIR__ . "/latency.json";
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
- `intval` + range check `[-1, 500]` — accepts -1 (undefined/unsupported), 1-500 (capped latency), rejects 0 (uninitialised) and anything above 500.
- CORS restricted to `opendaw.studio` and `localhost`.
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

**Decision: D — once per (user, latency) pair.** Each user contributes each distinct ms value exactly once via `localStorage`. Device changes produce new values which are reported separately. Server just counts; dedup is purely client-side. See client section above for implementation.

## 6. Decisions (resolved)
1. **Bucket width**: 1 ms.
2. **Dedup**: D — once per (user, latency value). localStorage-based.
3. **Hook location**: find `new AudioContext` in codebase + `devicechange` listener for output device swaps.
4. **Server path**: same convention as `api.opendaw.studio/users/` — `api.opendaw.studio/latency.php` + `latency.json`.
5. **CORS**: restrict to `opendaw.studio` and `localhost`.
6. **Histogram placement**: last card in `StatsBody` (full-width, after the rooms/hours charts).
7. **Color**: no preference stated — use whatever fits the palette.
8. **Outlier cap**: 500 ms. Values above 500 ms are **capped to 500** (still counted, not rejected). `undefined` values are reported as `-1` and displayed as "N/A" on the chart.

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
