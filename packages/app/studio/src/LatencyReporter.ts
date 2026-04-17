import {isDefined} from "@opendaw/lib-std"

const STORAGE_KEY = "reported-latencies"
const API_URL = "https://api.opendaw.studio/latency/report.php"
const MAX_MS = 500

const bucketMs = (context: AudioContext): number => {
    const raw = context.outputLatency
    if (!isDefined(raw) || raw === 0) return -1
    return Math.min(MAX_MS, Math.round(raw * 1000))
}

const report = (ms: number): void => {
    const reported: ReadonlyArray<number> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    if (reported.includes(ms)) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...reported, ms]))
    navigator.sendBeacon(API_URL, JSON.stringify({latency: ms}))
}

export const installLatencyReporter = (context: AudioContext): void => {
    const check = () => {
        if (context.state !== "running") return
        const ms = bucketMs(context)
        if (ms !== -1) report(ms)
    }
    setInterval(check, 10_000)
}