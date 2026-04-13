import css from "./PerformancePage.sass?inline"
import {createElement, PageFactory} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {BenchmarkCategory, BenchmarkResult, RENDER_SECONDS, runAllBenchmarks, SAMPLE_RATE} from "@/perf/benchmarks"
import {isDefined} from "@moises-ai/lib-std"
import {Button} from "@/ui/components/Button"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "PerformancePage")

const CategoryOrder: ReadonlyArray<BenchmarkCategory> = ["Baseline", "Audio Effect", "Instrument"]

let activeAudio: HTMLAudioElement | null = null

const createAudioElement = (audio: Float32Array[]): HTMLAudioElement => {
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
    const audioElement = document.createElement("audio")
    audioElement.controls = true
    audioElement.src = URL.createObjectURL(blob)
    audioElement.addEventListener("play", () => {
        if (activeAudio !== null && activeAudio !== audioElement) {
            activeAudio.pause()
            activeAudio.currentTime = 0
        }
        activeAudio = audioElement
    })
    return audioElement
}

export const PerformancePage: PageFactory<StudioService> = ({service, lifecycle}) => {
    const results: Array<BenchmarkResult> = []
    const tbody = <tbody/>
    const statusEl: HTMLSpanElement = <span className="status">Ready</span>
    let running = false
    const renderRow = (result: BenchmarkResult, maxMarginal: number): Element => {
        if (isDefined(result.error)) {
            return (
                <tr className="error">
                    <td className="name">{result.name}</td>
                    <td className="number" colSpan={5}>{result.error}</td>
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
        const maxMarginal = results.reduce((max, result) => Math.max(max, result.marginalMs), 0)
        tbody.replaceChildren()
        for (const category of CategoryOrder) {
            const categoryResults = results.filter(result => result.category === category)
            if (categoryResults.length === 0) {continue}
            tbody.appendChild(
                <tr className="category">
                    <td colSpan={6}>{category}</td>
                </tr>
            )
            for (const result of categoryResults.sort((a, b) => b.renderMs - a.renderMs)) {
                tbody.appendChild(renderRow(result, maxMarginal))
            }
        }
    }
    const run = async () => {
        if (running) {return}
        running = true
        results.length = 0
        updateTable()
        statusEl.textContent = "Starting benchmarks..."
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
        running = false
        statusEl.textContent = `Done. ${results.length} benchmarks completed.`
    }
    return (
        <div className={className}>
            <h1>DSP Performance Benchmarks</h1>
            <div style={{opacity: "0.5", fontSize: "12px", display: "flex", flexDirection: "column", gap: "4px"}}>
                <span>Each device runs in its own project that renders {RENDER_SECONDS}s of audio at {SAMPLE_RATE / 1000}kHz offline (faster than real-time, no playback).</span>
                <span><b>render</b> — wall-clock time to render the full {RENDER_SECONDS}s. Includes engine overhead, channel strip, and the device itself.</span>
                <span><b>marginal</b> — render time minus the baseline (a project with only a Tape instrument, no effects). This isolates the cost added by the device.</span>
                <span><b>per quantum</b> — marginal cost divided by the number of 128-sample blocks rendered ({(RENDER_SECONDS * SAMPLE_RATE / 128).toLocaleString()} blocks). Shows how much time the device adds to each audio callback.</span>
            </div>
            <div className="controls">
                <Button lifecycle={lifecycle}
                        appearance={{framed: true, color: Colors.blue}}
                        style={{fontSize: "0.75em"}}
                        onClick={run}>Run All</Button>
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
            <div style={{opacity: "0.4", fontSize: "11px"}}>
                Negative marginal values indicate measurement noise — the device cost is too small to measure reliably.
            </div>
        </div>
    )
}
