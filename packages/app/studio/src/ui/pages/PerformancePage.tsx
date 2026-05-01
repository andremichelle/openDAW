import css from "./PerformancePage.sass?inline"
import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {
    BenchmarkCategory,
    BenchmarkResult,
    MemoryResult,
    RENDER_SECONDS,
    runAllBenchmarks,
    runMemoryBenchmarks,
    SAMPLE_RATE
} from "@/perf/benchmarks"
import {isDefined} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Button} from "@/ui/components/Button"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "PerformancePage")

const CategoryOrder: ReadonlyArray<BenchmarkCategory> = ["Baseline", "Audio Effect", "Instrument", "Memory"]

const memoryToBenchmark = (result: MemoryResult): BenchmarkResult => ({
    category: "Memory",
    name: `${result.label} (${result.thread})`,
    renderMs: result.bestMs,
    marginalMs: 0,
    perQuantumUs: 0,
    durationSeconds: 0,
    memory: {
        backing: result.backing,
        pattern: result.pattern,
        thread: result.thread,
        sizeMB: result.sizeMB,
        mbPerSec: result.mbPerSec,
        nsPerOp: result.nsPerOp,
        bestMs: result.bestMs,
        medianMs: result.medianMs
    }
})

let activeAudio: HTMLAudioElement | null = null

const createAudioElement = (audio: Float32Array[]): HTMLElement => {
    const length = audio[0].length
    const numChannels = Math.min(audio.length, 2)
    const buffer = new ArrayBuffer(44 + length * numChannels * 2)
    const view = new DataView(buffer)
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {view.setUint8(offset + i, str.charCodeAt(i))}
    }
    const dataSize = length * numChannels * 2
    writeString(0, "RIFF")
    view.setUint32(4, 36 + dataSize, true)
    writeString(8, "WAVE")
    writeString(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, SAMPLE_RATE, true)
    view.setUint32(28, SAMPLE_RATE * numChannels * 2, true)
    view.setUint16(32, numChannels * 2, true)
    view.setUint16(34, 16, true)
    writeString(36, "data")
    view.setUint32(40, dataSize, true)
    let offset = 44
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, audio[ch][i]))
            view.setInt16(offset, sample * 0x7FFF, true)
            offset += 2
        }
    }
    const blob = new Blob([buffer], {type: "audio/wav"})
    const audioElement: HTMLAudioElement = document.createElement("audio")
    audioElement.src = URL.createObjectURL(blob)
    const playButton: HTMLButtonElement = document.createElement("button")
    playButton.className = "play"
    playButton.textContent = "▶"
    playButton.title = "Play / pause"
    playButton.onclick = () => {
        if (audioElement.paused) {audioElement.play()} else {audioElement.pause()}
    }
    audioElement.addEventListener("play", () => {
        if (activeAudio !== null && activeAudio !== audioElement) {
            activeAudio.pause()
            activeAudio.currentTime = 0
        }
        activeAudio = audioElement
        playButton.textContent = "■"
    })
    audioElement.addEventListener("pause", () => {playButton.textContent = "▶"})
    audioElement.addEventListener("ended", () => {playButton.textContent = "▶"})
    return playButton
}

export const PerformancePage: PageFactory<StudioService> = ({service, lifecycle}) => {
    const results: Array<BenchmarkResult> = []
    const tbody = <tbody/>
    const statusEl: HTMLSpanElement = <span className="status">Ready</span>
    let running = false
    let runButtonInput: HTMLInputElement | null = null
    let copyButtonInput: HTMLInputElement | null = null
    const setRunning = (active: boolean) => {
        running = active
        if (isDefined(runButtonInput)) {runButtonInput.disabled = active}
        if (isDefined(copyButtonInput)) {copyButtonInput.disabled = active}
    }
    const renderRow = (result: BenchmarkResult, maxMarginal: number, maxMbPerSec: number): Element => {
        if (isDefined(result.error)) {
            return (
                <tr className="error">
                    <td className="name">{result.name}</td>
                    <td className="number" colSpan={5}>{result.error}</td>
                </tr>
            )
        }
        if (isDefined(result.memory)) {
            const memory = result.memory
            const barWidth = maxMbPerSec > 0 ? (memory.mbPerSec / maxMbPerSec) * 100 : 0
            return (
                <tr>
                    <td className="name">{result.name}</td>
                    <td className="number">{memory.bestMs.toFixed(2)}</td>
                    <td className="number">{memory.mbPerSec.toFixed(0)} MB/s</td>
                    <td className="number">{memory.nsPerOp.toFixed(2)} ns/op</td>
                    <td className="bar-cell">
                        <div className="bar" style={{width: `${barWidth.toFixed(1)}%`}}/>
                    </td>
                    <td className="audio-cell"/>
                </tr>
            )
        }
        const barWidth = result.marginalMs > 0 && maxMarginal > 0
            ? (result.marginalMs / maxMarginal) * 100 : 0
        const isBaseline = result.category === "Baseline"
        return (
            <tr>
                <td className="name">{result.name}</td>
                <td className="number">{result.renderMs.toFixed(0)}</td>
                <td className="number">{isBaseline ? "-" : result.marginalMs.toFixed(0)}</td>
                <td className="number">{isBaseline ? "-" : result.perQuantumUs.toFixed(2)}</td>
                <td className="bar-cell">
                    <div className="bar" style={{width: `${barWidth.toFixed(1)}%`}}/>
                </td>
                <td className="audio-cell">
                    {isDefined(result.audio) ? createAudioElement(result.audio) : null}
                </td>
            </tr>
        )
    }
    const updateTable = () => {
        const maxMarginal = results.reduce((max, result) =>
            isDefined(result.memory) ? max : Math.max(max, result.marginalMs), 0)
        const maxMbPerSec = results.reduce((max, result) =>
            isDefined(result.memory) ? Math.max(max, result.memory.mbPerSec) : max, 0)
        tbody.replaceChildren()
        for (const category of CategoryOrder) {
            const categoryResults = results.filter(result => result.category === category)
            if (categoryResults.length === 0) {continue}
            tbody.appendChild(
                <tr className="category">
                    <td colSpan={6}>{category}</td>
                </tr>
            )
            const sorted = category === "Memory"
                ? categoryResults
                : categoryResults.slice().sort((a, b) => b.renderMs - a.renderMs)
            for (const result of sorted) {
                tbody.appendChild(renderRow(result, maxMarginal, maxMbPerSec))
            }
        }
    }
    const buildJsonReport = () => {
        const nav = navigator as Navigator & { deviceMemory?: number, userAgentData?: { platform?: string } }
        const device = results
            .filter(result => !isDefined(result.memory) && !isDefined(result.error))
            .map(result => ({
                category: result.category,
                name: result.name,
                renderMs: Number(result.renderMs.toFixed(2)),
                marginalMs: Number(result.marginalMs.toFixed(2)),
                perQuantumUs: Number(result.perQuantumUs.toFixed(3))
            }))
        const memory = results
            .filter(result => isDefined(result.memory))
            .map(result => {
                const memoryData = result.memory!
                return {
                    name: result.name,
                    thread: memoryData.thread,
                    backing: memoryData.backing,
                    pattern: memoryData.pattern,
                    sizeMB: memoryData.sizeMB,
                    bestMs: Number(memoryData.bestMs.toFixed(3)),
                    medianMs: Number(memoryData.medianMs.toFixed(3)),
                    mbPerSec: Number(memoryData.mbPerSec.toFixed(0)),
                    nsPerOp: Number(memoryData.nsPerOp.toFixed(3))
                }
            })
        const errors = results
            .filter(result => isDefined(result.error))
            .map(result => ({name: result.name, category: result.category, error: result.error!}))
        return {
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            platform: nav.userAgentData?.platform ?? navigator.platform,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemoryGB: nav.deviceMemory ?? null,
            crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
            buildVersion: import.meta.env.BUILD_UUID ?? null,
            settings: {sampleRate: SAMPLE_RATE, renderSeconds: RENDER_SECONDS},
            device,
            memory,
            errors
        }
    }
    const copyResults = async () => {
        if (running) {return}
        if (results.length === 0) {
            statusEl.textContent = "Nothing to copy yet."
            return
        }
        const json = JSON.stringify(buildJsonReport(), null, 2)
        const result = await Promises.tryCatch(navigator.clipboard.writeText(json))
        statusEl.textContent = result.status === "resolved"
            ? `Copied ${results.length} results to clipboard (${json.length} chars).`
            : "Copy failed: clipboard access denied."
    }
    const run = async () => {
        if (running) {return}
        setRunning(true)
        results.length = 0
        updateTable()
        statusEl.textContent = "Starting memory benchmarks..."
        try {
            await runMemoryBenchmarks(
                progress => {
                    statusEl.textContent = `[memory ${progress.index + 1}/${progress.total}] ${progress.current}...`
                },
                memoryResult => {
                    results.push(memoryToBenchmark(memoryResult))
                    updateTable()
                },
                workerError => {
                    results.push({
                        category: "Memory",
                        name: "Memory worker",
                        renderMs: 0,
                        marginalMs: 0,
                        perQuantumUs: 0,
                        durationSeconds: 0,
                        error: workerError.message
                    })
                    updateTable()
                }
            )
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn("Memory benchmark failed:", message)
            results.push({
                category: "Memory",
                name: "Memory benchmark",
                renderMs: 0,
                marginalMs: 0,
                perQuantumUs: 0,
                durationSeconds: 0,
                error: message
            })
            updateTable()
        }
        statusEl.textContent = "Starting device benchmarks..."
        try {
            await runAllBenchmarks(
                service,
                progress => {
                    statusEl.textContent = `[${progress.index + 1}/${progress.total}] ${progress.current}...`
                },
                result => {
                    results.push(result)
                    updateTable()
                }
            )
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn("Device benchmarks failed:", message)
            results.push({
                category: "Baseline",
                name: "Device benchmarks",
                renderMs: 0,
                marginalMs: 0,
                perQuantumUs: 0,
                durationSeconds: 0,
                error: message
            })
            updateTable()
        }
        setRunning(false)
        statusEl.textContent = `Done. ${results.length} benchmarks completed.`
    }
    return (
        <div className={className}>
            <h1>DSP Performance Benchmarks</h1>
            <div className="description">
                <span>Each device runs in its own project that renders {RENDER_SECONDS}s of audio at {SAMPLE_RATE / 1000}kHz offline (faster than real-time, no playback).</span>
                <span><b>render</b> — wall-clock time to render the full {RENDER_SECONDS}s. Includes engine overhead, channel strip, and the device itself.</span>
                <span><b>marginal</b> — render time minus the baseline (a project with only a Tape instrument, no effects). This isolates the cost added by the device.</span>
                <span><b>per quantum</b> — marginal cost divided by the number of 128-sample blocks rendered ({(RENDER_SECONDS * SAMPLE_RATE / 128).toLocaleString()} blocks). Shows how much time the device adds to each audio callback.</span>
                <span><b>Memory</b> rows compare ArrayBuffer (AB) vs SharedArrayBuffer (SAB) reads at different sizes and access patterns, on the main thread and inside a Web Worker. The render column shows best-of-7 ms per run, the second column shows throughput (MB/s), the third shows nanoseconds per element. Each test runs 5 untimed warmup passes before timing.</span>
                <span>Negative marginal values indicate measurement noise, the device cost is too small to measure reliably.</span>
            </div>
            <div className="controls">
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, color: Colors.blue}}
                        style={{fontSize: "0.75em"}}
                        onInit={element => {runButtonInput = element as HTMLInputElement}}
                        onClick={run}>Run All</Button>
                <Button lifecycle={lifecycle}
                        appearance={{framed: true}}
                        style={{fontSize: "0.75em"}}
                        onInit={element => {copyButtonInput = element as HTMLInputElement}}
                        onClick={copyResults}>Copy Results</Button>
                {statusEl}
            </div>
            <table>
                <thead>
                <tr>
                    <th>Device</th>
                    <th>render (ms)</th>
                    <th>marginal (ms)</th>
                    <th>per quantum (us)</th>
                    <th>relative</th>
                    <th></th>
                </tr>
                </thead>
                {tbody}
            </table>
        </div>
    )
}
