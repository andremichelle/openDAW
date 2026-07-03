import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {OfflineResult, resultPeak, resultRms} from "../../perf/result"
import type {RenderRequest, RenderResponse} from "../../perf/render-worker"

// Renders a loaded bundle front-to-end through the WASM engine and the TS studio engine as fast as possible
// (offline, no realtime), IN A WEB WORKER so the main thread never blocks. Only the render loop is timed; decode,
// sample loading and engine setup are excluded. The two renders are shown as audio players with an A/B switch.
const SAMPLE_RATE = 48000
const WAVE_WIDTH = 900
const WAVE_HEIGHT = 96

// Draw a min/max peak-envelope waveform of the mixed stereo into a canvas (one column per pixel). `gain` scales
// the amplitude (used to normalize the small difference plot so its shape is visible).
const drawWaveform = (canvas: HTMLCanvasElement, result: OfflineResult, color: string, gain = 1): void => {
    const context = canvas.getContext("2d")
    if (context === null) {return}
    const {left, right} = result
    const frames = left.length
    const {width, height} = canvas
    const mid = height / 2
    const clamp = (value: number): number => Math.max(-1, Math.min(1, value * gain))
    context.clearRect(0, 0, width, height)
    context.strokeStyle = "rgba(255, 255, 255, 0.12)"
    context.beginPath(); context.moveTo(0, mid + 0.5); context.lineTo(width, mid + 0.5); context.stroke()
    context.strokeStyle = color
    context.beginPath()
    for (let x = 0; x < width; x++) {
        const start = Math.floor(x / width * frames)
        const end = Math.max(start + 1, Math.floor((x + 1) / width * frames))
        let min = 0, max = 0
        for (let index = start; index < end && index < frames; index++) {
            const sample = (left[index] + right[index]) * 0.5
            if (sample < min) {min = sample}
            if (sample > max) {max = sample}
        }
        context.moveTo(x + 0.5, mid - clamp(max) * mid)
        context.lineTo(x + 0.5, mid - clamp(min) * mid)
    }
    context.stroke()
}

// The sample-by-sample difference (WASM − TS) as a result, so it can be drawn like a waveform to localize where
// the two engines diverge.
const differenceResult = (wasm: OfflineResult, ts: OfflineResult): OfflineResult => {
    const frames = Math.min(wasm.left.length, ts.left.length)
    const left = new Float32Array(frames), right = new Float32Array(frames)
    for (let index = 0; index < frames; index++) {
        left[index] = wasm.left[index] - ts.left[index]
        right[index] = wasm.right[index] - ts.right[index]
    }
    return {left, right, renderMs: 0, sampleRate: wasm.sampleRate}
}

export const PerformancePage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Choose an <code>.odb</code> bundle, then Render.</p>
    const results: HTMLDivElement = <div className="perf-results"/>
    const seconds: HTMLInputElement = <input type="number" min="1" max="600" value="60" style="width: 5em"/>
    const renderButton: HTMLButtonElement = <button disabled={true}>Render A/B</button>
    let bundleBytes: ArrayBuffer | null = null
    let worker: Worker | null = null
    let audioCtx: AudioContext | null = null // the A/B playback graph, closed on re-render / teardown
    let rafId = 0 // the cursor animation loop, cancelled on re-render / teardown

    const setBusy = (busy: boolean) => {renderButton.disabled = busy || bundleBytes === null}

    const buildPlayers = (wasm: OfflineResult, ts: OfflineResult) => {
        cancelAnimationFrame(rafId)
        audioCtx?.close()
        // SAMPLE-ACCURATE A/B: both renders play as buffer sources on ONE AudioContext clock, started together,
        // so they are locked sample-for-sample forever (no per-switch currentTime drift). A/B just crossfades the
        // two gains — nothing reseeks, so the comparison is honest. Match the context rate to the render's so the
        // buffers are not resampled.
        const ctx = new AudioContext({sampleRate: wasm.sampleRate})
        audioCtx = ctx
        const toBuffer = (result: OfflineResult): AudioBuffer => {
            const buffer = ctx.createBuffer(2, result.left.length, result.sampleRate)
            buffer.copyToChannel(result.left, 0); buffer.copyToChannel(result.right, 1)
            return buffer
        }
        const wasmBuffer = toBuffer(wasm), tsBuffer = toBuffer(ts)
        const wasmGain = ctx.createGain(), tsGain = ctx.createGain()
        wasmGain.gain.value = 1; tsGain.gain.value = 0
        wasmGain.connect(ctx.destination); tsGain.connect(ctx.destination)
        const faster = wasm.renderMs <= ts.renderMs
        const ratio = faster ? ts.renderMs / wasm.renderMs : wasm.renderMs / ts.renderMs
        const wasmPeak = resultPeak(wasm), tsPeak = resultPeak(ts)
        const wasmRms = resultRms(wasm), tsRms = resultRms(ts)
        const levelDelta = wasmRms > 0 && tsRms > 0 ? 20 * Math.log10(wasmRms / tsRms) : 0
        const duration = wasm.left.length / wasm.sampleRate
        let activeIsWasm = true
        let sources: {wasm: AudioBufferSourceNode, ts: AudioBufferSourceNode} | null = null
        let startTime = 0, offset = 0 // ctx time both sources started at, and the buffer offset they started from
        const position = (): number => (sources !== null ? offset + (ctx.currentTime - startTime) : offset) % duration
        const playing = (): boolean => sources !== null && ctx.state === "running"
        const stopSources = () => {if (sources !== null) {sources.wasm.stop(); sources.ts.stop(); sources = null}}
        const startAt = (from: number) => {
            stopSources()
            const wasmSource = ctx.createBufferSource(); wasmSource.buffer = wasmBuffer; wasmSource.loop = true; wasmSource.connect(wasmGain)
            const tsSource = ctx.createBufferSource(); tsSource.buffer = tsBuffer; tsSource.loop = true; tsSource.connect(tsGain)
            wasmSource.start(ctx.currentTime, from % duration); tsSource.start(ctx.currentTime, from % duration)
            sources = {wasm: wasmSource, ts: tsSource}; startTime = ctx.currentTime; offset = from
        }
        const label: HTMLSpanElement = <span className="perf-active">Active: WASM</span>
        const playButton: HTMLButtonElement = <button>▶ Play</button>
        const syncPlayLabel = () => playButton.textContent = playing() ? "⏸ Pause" : "▶ Play"
        playButton.onclick = () => {
            if (playing()) {void ctx.suspend().then(syncPlayLabel)} else {
                if (sources === null) {startAt(offset)}
                void ctx.resume().then(syncPlayLabel)
            }
        }
        const flip = () => {
            activeIsWasm = !activeIsWasm
            wasmGain.gain.setTargetAtTime(activeIsWasm ? 1 : 0, ctx.currentTime, 0.004)
            tsGain.gain.setTargetAtTime(activeIsWasm ? 0 : 1, ctx.currentTime, 0.004)
            label.textContent = `Active: ${activeIsWasm ? "WASM" : "TS"}`
        }
        const abButton: HTMLButtonElement = <button onclick={flip}>A/B Switch (WASM ⇄ TS)</button>
        const silent = Math.max(wasmPeak, tsPeak) < 1e-4
        // A waveform per render + a playback cursor. Both cursors track the ACTIVE render's time (A/B keeps the two
        // aligned), so any visual difference between the two waveforms is a real render difference, not drift.
        const wasmCursor: HTMLDivElement = <div className="perf-cursor"/>
        const tsCursor: HTMLDivElement = <div className="perf-cursor"/>
        const diffCursor: HTMLDivElement = <div className="perf-cursor"/>
        const waveform = (result: OfflineResult, color: string, cursor: HTMLDivElement, gain = 1): HTMLElement => {
            const canvas: HTMLCanvasElement = <canvas width={WAVE_WIDTH} height={WAVE_HEIGHT} className="perf-wave"/>
            drawWaveform(canvas, result, color, gain)
            const wrap: HTMLDivElement = <div className="perf-wave-wrap">{canvas}{cursor}</div>
            wrap.onclick = (event: MouseEvent) => {
                const rect = wrap.getBoundingClientRect()
                startAt((event.clientX - rect.left) / rect.width * duration) // reseek BOTH sources together
                syncPlayLabel()
            }
            return wrap
        }
        const diff = differenceResult(wasm, ts)
        const diffPeak = resultPeak(diff)
        const diffRms = resultRms(diff)
        // Null-test residual: how far the (WASM − TS) difference sits BELOW the signal, in dB. −∞ = bit-identical.
        const residual = diffRms > 0 && wasmRms > 0 ? 20 * Math.log10(diffRms / wasmRms) : -Infinity
        const residualText = Number.isFinite(residual) ? `${residual.toFixed(1)} dB` : "−∞ (identical)"
        const diffGain = diffPeak > 1e-6 ? 0.95 / diffPeak : 1 // normalize so the (small) difference is visible
        const tick = () => {
            const percent = `${Math.min(100, position() / duration * 100)}%`
            wasmCursor.style.left = percent; tsCursor.style.left = percent; diffCursor.style.left = percent
            rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
        results.replaceChildren(
            <div className="perf-summary">
                <div className="perf-metric"><span>WASM render</span><strong>{wasm.renderMs.toFixed(1)} ms</strong></div>
                <div className="perf-metric"><span>TS render</span><strong>{ts.renderMs.toFixed(1)} ms</strong></div>
                <div className="perf-metric"><span>{faster ? "WASM faster by" : "TS faster by"}</span><strong>{ratio.toFixed(2)}×</strong></div>
                <div className="perf-metric"><span>loudness Δ (RMS)</span><strong>{levelDelta >= 0 ? "+" : ""}{levelDelta.toFixed(2)} dB</strong></div>
                <div className="perf-metric"><span>null residual</span><strong>{residualText}</strong></div>
                <div className="perf-metric"><span>max sample Δ</span><strong>{diffPeak.toFixed(4)}</strong></div>
            </div>,
            <p className="perf-note">Same content nulls to −∞. <b>loudness Δ</b>: level match (RMS). <b>null residual</b>:
                how far the WASM−TS difference sits below the signal. <b>max sample Δ</b>: largest single-sample
                deviation (0–2 full-scale).</p>,
            silent
                ? <p className="perf-active">Both renders are silent — the project likely starts with silence or uses
                    the clip launcher (which a front-to-end arrangement render does not trigger). Try a longer length,
                    or a bundle whose arrangement has content from the start.</p>
                : <div className="perf-ab">{playButton} {abButton} {label}</div>,
            <div className="perf-player"><h4>WASM</h4>{waveform(wasm, "#57c7ff", wasmCursor)}</div>,
            <div className="perf-player"><h4>TS (studio engine)</h4>{waveform(ts, "#ffb057", tsCursor)}</div>,
            <div className="perf-player">
                <h4>Difference (WASM − TS) — normalized ×{diffGain.toFixed(0)}, peak {diffPeak.toFixed(4)}</h4>
                {waveform(diff, "#ff5d7a", diffCursor, diffGain)}
            </div>
        )
    }

    const render = () => {
        if (bundleBytes === null) {return}
        setBusy(true)
        results.replaceChildren()
        worker?.terminate()
        const quanta = Math.ceil((Math.max(1, seconds.valueAsNumber || 60) * SAMPLE_RATE) / RenderQuantum)
        status.textContent = `Rendering ~${(quanta * RenderQuantum / SAMPLE_RATE).toFixed(1)} s in a worker…`
        worker = new Worker(new URL("../../perf/render-worker.ts", import.meta.url), {type: "module"})
        worker.onmessage = (event: MessageEvent<RenderResponse>) => {
            const message = event.data
            if (message.type === "progress") {
                status.textContent = message.message
            } else if (message.type === "done") {
                buildPlayers(message.wasm, message.ts)
                status.textContent = `Done. WASM ${message.wasm.renderMs.toFixed(1)} ms vs TS ${message.ts.renderMs.toFixed(1)} ms (render loop only).`
                worker?.terminate(); worker = null; setBusy(false)
            } else {
                status.textContent = `Render failed: ${message.message}`
                worker?.terminate(); worker = null; setBusy(false)
            }
        }
        worker.onerror = (event) => {
            status.textContent = `Worker error: ${event.message}`
            worker?.terminate(); worker = null; setBusy(false)
        }
        const copy = bundleBytes.slice(0) // transfer a copy so the original stays for re-renders
        const request: RenderRequest = {odb: copy, quanta, sampleRate: SAMPLE_RATE}
        worker.postMessage(request, [copy])
    }
    renderButton.onclick = () => render()

    const input: HTMLInputElement = <input type="file" accept=".odb"/>
    input.onchange = () => {
        const file = input.files?.[0]
        if (file === undefined) {return}
        status.textContent = `Reading ${file.name}…`
        bundleBytes = null; setBusy(true)
        file.arrayBuffer()
            .then(buffer => {
                bundleBytes = buffer
                status.textContent = `Loaded ${file.name} (${(buffer.byteLength / 1_000_000).toFixed(1)} MB). Set a length and Render.`
                setBusy(false)
            })
            .catch(reason => {status.textContent = `Failed to read: ${reason instanceof Error ? reason.message : String(reason)}`})
    }
    lifecycle.own({terminate: () => {cancelAnimationFrame(rafId); worker?.terminate(); audioCtx?.close()}})

    return (
        <div className="page">
            <h2>Performance A/B</h2>
            <p>Renders a bundle front-to-end through the WASM engine and the TS studio engine as fast as possible
                (offline, in a worker). Only the render loop is timed; decode, sample loading and engine setup are
                excluded. Compare the two renders with the A/B switch.</p>
            <div className="metro-controls">
                <label>Bundle </label>{input}
                <label>Length (s) </label>{seconds}
                {renderButton}
            </div>
            {status}
            {results}
        </div>
    )
}
