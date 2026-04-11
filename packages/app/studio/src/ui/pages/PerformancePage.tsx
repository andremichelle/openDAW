import css from "./PerformancePage.sass?inline"
import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {BenchmarkCategory, BenchmarkResult, RENDER_SECONDS, runAllBenchmarks, SAMPLE_RATE} from "@/perf/benchmarks"
import {isDefined} from "@opendaw/lib-std"

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
    const el = document.createElement("audio")
    el.controls = true
    el.src = URL.createObjectURL(blob)
    el.addEventListener("play", () => {
        if (activeAudio !== null && activeAudio !== el) {
            activeAudio.pause()
            activeAudio.currentTime = 0
        }
        activeAudio = el
    })
    return el
}

export const PerformancePage: PageFactory<StudioService> = ({service}) => {
    const results: Array<BenchmarkResult> = []
    let running = false
    let tbody: HTMLTableSectionElement
    let statusEl: HTMLSpanElement
    let runButton: HTMLButtonElement
    const updateTable = () => {
        const maxMarginal = results.reduce((max, result) => Math.max(max, result.marginalMs), 0)
        tbody.innerHTML = ""
        for (const category of CategoryOrder) {
            const categoryResults = results.filter(result => result.category === category)
            if (categoryResults.length === 0) {continue}
            const headerRow = document.createElement("tr")
            headerRow.className = "category"
            headerRow.innerHTML = `<td colspan="6">${category}</td>`
            tbody.appendChild(headerRow)
            for (const result of categoryResults.sort((a, b) => b.renderMs - a.renderMs)) {
                const row = document.createElement("tr")
                if (isDefined(result.error)) {
                    row.className = "error"
                    row.innerHTML = `<td class="name">${result.name}</td>`
                        + `<td class="number" colspan="5">${result.error}</td>`
                } else {
                    const barWidth = result.marginalMs > 0 && maxMarginal > 0
                        ? (result.marginalMs / maxMarginal) * 100 : 0
                    const isBaseline = result.category === "Baseline"
                    row.innerHTML = `<td class="name">${result.name}</td>`
                        + `<td class="number">${result.renderMs.toFixed(0)}</td>`
                        + `<td class="number">${isBaseline ? "-" : result.marginalMs.toFixed(0)}</td>`
                        + `<td class="number">${isBaseline ? "-" : result.perQuantumUs.toFixed(2)}</td>`
                        + `<td class="bar-cell"><div class="bar" style="width: ${barWidth.toFixed(1)}%"></div></td>`
                        + `<td class="audio-cell"></td>`
                    if (isDefined(result.audio)) {
                        const audioCell = row.querySelector(".audio-cell")
                        if (isDefined(audioCell)) {audioCell.appendChild(createAudioElement(result.audio))}
                    }
                }
                tbody.appendChild(row)
            }
        }
    }
    const run = async () => {
        if (running) {return}
        running = true
        results.length = 0
        updateTable()
        runButton.disabled = true
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
        runButton.disabled = false
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
                <button onInit={element => { runButton = element; element.onclick = run }}>Run All</button>
                <span className="status" onInit={element => statusEl = element}>Ready</span>
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
                <tbody onInit={element => tbody = element}/>
            </table>
            <div style={{opacity: "0.4", fontSize: "11px"}}>
                Negative marginal values indicate measurement noise — the device cost is too small to measure reliably.
            </div>
        </div>
    )
}
