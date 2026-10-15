import css from "./SampleReadPage.sass?inline"
import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {Html, Platform} from "@opendaw/lib-dom"
import {isDefined} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Colors} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {StudioService} from "@/service/StudioService"
import {runSampleReadBenchmarks, SampleReadWorkerError} from "@/perf/SampleReadRunner"
import {SampleReadResult, SampleReadThread} from "@/perf/SampleReadBenchmark"

const className = Html.adoptStyleSheet(css, "SampleReadPage")

type Row = {
    readonly result?: SampleReadResult
    readonly error?: { readonly label: string, readonly message: string }
}

type VerdictKind = "win" | "loss" | "neutral"

// Δ time %  = (blockcopy − direct) / direct × 100
//   > 0  → block-copy took MORE time than direct (regression / LOSS)
//   < 0  → block-copy took LESS time than direct (improvement / WIN)
const timeDeltaPct = (directNs: number, blockcopyNs: number): number =>
    directNs > 0 && isFinite(directNs) && isFinite(blockcopyNs)
        ? (blockcopyNs - directNs) / directNs * 100
        : NaN

const verdictForDeltaPct = (deltaPct: number): { text: string, kind: VerdictKind } => {
    if (!isFinite(deltaPct)) {return {text: "n/a", kind: "neutral"}}
    if (deltaPct <= -10) {return {text: "WIN", kind: "win"}}      // saved at least 10% time
    if (deltaPct >= 5)   {return {text: "LOSS", kind: "loss"}}    // costs at least 5% more time
    return {text: "wash", kind: "neutral"}
}

const formatSignedPct = (pct: number): string => {
    if (!isFinite(pct)) {return "n/a"}
    const sign = pct > 0 ? "+" : ""
    return `${sign}${pct.toFixed(1)} %`
}

const geomean = (values: ReadonlyArray<number>): number => {
    const valid = values.filter(value => isFinite(value) && value > 0)
    if (valid.length === 0) {return 0}
    let logSum = 0
    for (const value of valid) {logSum += Math.log(value)}
    return Math.exp(logSum / valid.length)
}

export const SampleReadPage: PageFactory<StudioService> = ({lifecycle}) => {
    const rows: Array<Row> = []
    const tbody = <tbody/>
    const headlineEl: HTMLDivElement = <div className="headline"/>
    const statusEl: HTMLSpanElement = <span className="status">Ready</span>
    let running = false
    let runButtonInput: HTMLInputElement | null = null
    let copyButtonInput: HTMLInputElement | null = null
    const setRunning = (active: boolean) => {
        running = active
        if (isDefined(runButtonInput)) {runButtonInput.disabled = active}
        if (isDefined(copyButtonInput)) {copyButtonInput.disabled = active}
    }
    const renderRow = (row: Row): Element => {
        if (isDefined(row.error)) {
            return (
                <tr className="error">
                    <td className="name">{row.error.label}</td>
                    <td className="number" colSpan={5}>{row.error.message}</td>
                </tr>
            )
        }
        const result = row.result!
        const deltaPct = timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample)
        const verdict = verdictForDeltaPct(deltaPct)
        return (
            <tr>
                <td className="name">{result.label}</td>
                <td className="thread">{result.thread}</td>
                <td className="number">{result.directNsPerSample.toFixed(2)}</td>
                <td className="number">{result.blockcopyNsPerSample.toFixed(2)}</td>
                <td className={verdict.kind}>{formatSignedPct(deltaPct)}</td>
                <td className={verdict.kind}>{verdict.text}</td>
            </tr>
        )
    }
    const renderHeadline = () => {
        Html.empty(headlineEl)
        const valid = rows.filter(row => isDefined(row.result)).map(row => row.result!)
        if (valid.length === 0) {
            headlineEl.appendChild(<span className="headline-label">No measurements yet — click Run.</span>)
            return
        }
        for (const thread of ["main", "worker"] as ReadonlyArray<SampleReadThread>) {
            const subset = valid.filter(result => result.thread === thread)
            if (subset.length === 0) {continue}
            const ratios = subset.map(result =>
                result.blockcopyNsPerSample / result.directNsPerSample)
            const geoRatio = geomean(ratios)
            const geoDeltaPct = isFinite(geoRatio) && geoRatio > 0
                ? (geoRatio - 1) * 100
                : NaN
            const verdict = verdictForDeltaPct(geoDeltaPct)
            const wins   = subset.filter(result =>
                timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample) <= -10).length
            const losses = subset.filter(result =>
                timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample) >= 5).length
            const wash   = subset.length - wins - losses
            const headlineText = isFinite(geoDeltaPct)
                ? geoDeltaPct >= 0
                    ? `block-copy takes ${geoDeltaPct.toFixed(1)} % more time (geomean)`
                    : `block-copy takes ${(-geoDeltaPct).toFixed(1)} % less time (geomean)`
                : "n/a"
            headlineEl.appendChild(
                <div className="headline-row">
                    <span className="headline-label">{thread} thread:</span>
                    <span className={Html.buildClassList("headline-value", verdict.kind)}>{headlineText}</span>
                    <span className="headline-label">{wins} win · {wash} wash · {losses} loss · {subset.length} rows</span>
                </div>
            )
        }
    }
    const updateTable = () => {
        tbody.replaceChildren()
        for (const thread of ["main", "worker"] as ReadonlyArray<SampleReadThread>) {
            const subset = rows.filter(row => isDefined(row.result) && row.result.thread === thread)
            if (subset.length === 0) {continue}
            tbody.appendChild(
                <tr className="section">
                    <td colSpan={6}>{thread === "main" ? "Main thread" : "Worker thread"}</td>
                </tr>
            )
            for (const row of subset) {tbody.appendChild(renderRow(row))}
        }
        const errorRows = rows.filter(row => isDefined(row.error))
        if (errorRows.length > 0) {
            tbody.appendChild(
                <tr className="section">
                    <td colSpan={6}>Errors</td>
                </tr>
            )
            for (const row of errorRows) {tbody.appendChild(renderRow(row))}
        }
        renderHeadline()
    }
    const buildJsonReport = () => {
        const nav = navigator as Navigator & { deviceMemory?: number, userAgentData?: { platform?: string } }
        const results = rows
            .filter(row => isDefined(row.result))
            .map(row => row.result!)
        const errors = rows
            .filter(row => isDefined(row.error))
            .map(row => row.error!)
        const summaries = (["main", "worker"] as ReadonlyArray<SampleReadThread>)
            .map(thread => {
                const subset = results.filter(result => result.thread === thread)
                if (subset.length === 0) {return null}
                const ratios = subset.map(result =>
                    result.blockcopyNsPerSample / result.directNsPerSample)
                const geoRatio = geomean(ratios)
                const geoDeltaPct = isFinite(geoRatio) && geoRatio > 0
                    ? (geoRatio - 1) * 100
                    : NaN
                return {
                    thread,
                    samples: subset.length,
                    geomeanTimeRatio: Number(geoRatio.toFixed(3)),
                    geomeanTimeDeltaPct: isFinite(geoDeltaPct) ? Number(geoDeltaPct.toFixed(2)) : null,
                    wins: subset.filter(result =>
                        timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample) <= -10).length,
                    losses: subset.filter(result =>
                        timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample) >= 5).length
                }
            })
            .filter(isDefined)
        return {
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            platform: nav.userAgentData?.platform ?? navigator.platform,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemoryGB: nav.deviceMemory ?? null,
            crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
            buildVersion: import.meta.env.BUILD_UUID ?? null,
            summaries,
            results: results.map(result => ({
                id: result.id,
                label: result.label,
                thread: result.thread,
                sizeMB: result.sizeMB,
                rateRatio: result.rateRatio,
                voices: result.voices,
                directNsPerSample: Number(result.directNsPerSample.toFixed(3)),
                blockcopyNsPerSample: Number(result.blockcopyNsPerSample.toFixed(3)),
                timeDeltaPct: Number(timeDeltaPct(result.directNsPerSample, result.blockcopyNsPerSample).toFixed(2))
            })),
            errors
        }
    }
    const copyResults = async () => {
        if (running) {return}
        if (rows.length === 0) {
            statusEl.textContent = "Nothing to copy yet."
            return
        }
        const json = JSON.stringify(buildJsonReport(), null, 2)
        const result = await Promises.tryCatch(Platform.writeClipboardText(json))
        statusEl.textContent = result.status === "resolved"
            ? `Copied ${rows.length} rows to clipboard (${json.length} chars).`
            : "Copy failed: clipboard access denied."
    }
    const run = async () => {
        if (running) {return}
        setRunning(true)
        rows.length = 0
        updateTable()
        statusEl.textContent = "Running sample-read benchmarks..."
        await runSampleReadBenchmarks(
            progress => {
                statusEl.textContent = `[${progress.index + 1}/${progress.total}] ${progress.current}...`
            },
            result => {
                rows.push({result})
                updateTable()
            },
            (error: SampleReadWorkerError) => {
                rows.push({error: {label: "worker", message: error.message}})
                updateTable()
            }
        )
        setRunning(false)
        const completed = rows.filter(row => isDefined(row.result)).length
        statusEl.textContent = `Done. ${completed} measurements collected.`
    }
    renderHeadline()
    return (
        <div className={className}>
            <h1>Sample-Read Block-Copy Benchmark</h1>
            <div className="description">
                <span>Compares the current Playfield-style direct read (interpolating directly from a multi-MB stereo source) against the proposed block-copy variant (memcpy a small window into a stack-local buffer once per quantum, interpolate from there). Both kernels live in this benchmark only; SampleVoice.ts is unchanged.</span>
                <span><b>direct ns/sample</b> — wall-clock nanoseconds per produced output sample with the current direct-read pattern.</span>
                <span><b>blockcopy ns/sample</b> — same workload after the proposed memcpy + L1-resident inner loop.</span>
                <span><b>Δ time %</b> — how much more (or less) time block-copy spent vs. direct. Positive means block-copy is slower (regression). Negative means it's faster (the gain we hoped for).</span>
                <span><b>verdict</b> — WIN (≥10% less time), wash (within −10% / +5%), LOSS (≥5% more time).</span>
                <span>Each row sweeps a sample size, pitch rate, and voice count. Higher pitch rates exercise the "more frames read per output sample" path; multiple voices spread reads across pages to amplify TLB pressure. Each measurement is best-of-7 after 3 warmup runs, calibrated to ~50 ms per timed run. The benchmark runs both on the main thread and inside a Web Worker — AudioWorklet has no high-resolution timer, so it cannot host this measurement.</span>
            </div>
            <div className="controls">
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, color: Colors.blue}}
                        style={{fontSize: "0.75em"}}
                        onInit={element => {runButtonInput = element as HTMLInputElement}}
                        onClick={run}>Run</Button>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true}}
                        style={{fontSize: "0.75em"}}
                        onInit={element => {copyButtonInput = element as HTMLInputElement}}
                        onClick={copyResults}>Copy Results</Button>
                {statusEl}
            </div>
            {headlineEl}
            <table>
                <thead>
                <tr>
                    <th>Test</th>
                    <th>thread</th>
                    <th className="number">direct (ns/sample)</th>
                    <th className="number">blockcopy (ns/sample)</th>
                    <th className="number">Δ time %</th>
                    <th className="number">verdict</th>
                </tr>
                </thead>
                {tbody}
            </table>
        </div>
    )
}
