import {Nullable} from "@opendaw/lib-std"
import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {OfflineResult, resultPeak} from "../../perf/result"
import type {RenderRequest, RenderResponse} from "../../perf/render-worker"

// Renders a loaded bundle front-to-end through the engine as fast as possible
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

export const PerformancePage: PageFactory<Env> = ({lifecycle}) => {
    const status: HTMLParagraphElement = <p>Choose an <code>.odb</code> bundle, then Render.</p>
    const results: HTMLDivElement = <div className="perf-results"/>
    const seconds: HTMLInputElement = <input type="number" min="1" max="600" value="60" style="width: 5em"/>
    const renderButton: HTMLButtonElement = <button disabled={true}>Render</button>
    let bundleBytes: ArrayBuffer | null = null
    let worker: Worker | null = null
    let audioCtx: Nullable<AudioContext> = null // the playback graph, closed on re-render / teardown
    let rafId = 0 // the cursor animation loop, cancelled on re-render / teardown

    const setBusy = (busy: boolean) => {renderButton.disabled = busy || bundleBytes === null}

    const buildPlayers = (wasm: OfflineResult) => {
        cancelAnimationFrame(rafId)
        audioCtx?.close()
        // Match the context rate to the render's so the buffer is not resampled.
        const ctx = new AudioContext({sampleRate: wasm.sampleRate})
        audioCtx = ctx
        const buffer = ctx.createBuffer(2, wasm.left.length, wasm.sampleRate)
        buffer.copyToChannel(wasm.left, 0)
        buffer.copyToChannel(wasm.right, 1)
        const peak = resultPeak(wasm)
        const duration = wasm.left.length / wasm.sampleRate
        let source: Nullable<AudioBufferSourceNode> = null
        let startTime = 0, offset = 0 // ctx time the source started at, and the buffer offset it started from
        const position = (): number => (source !== null ? offset + (ctx.currentTime - startTime) : offset) % duration
        const playing = (): boolean => source !== null && ctx.state === "running"
        const startAt = (from: number) => {
            if (source !== null) {source.stop(); source = null}
            const begin = Math.min(Math.max(0, from), duration) % duration // clamp into [0, duration) for start()
            const next = ctx.createBufferSource()
            next.buffer = buffer
            next.loop = true
            next.connect(ctx.destination)
            next.start(ctx.currentTime, begin)
            source = next
            startTime = ctx.currentTime
            offset = begin
        }
        const playButton: HTMLButtonElement = <button>▶ Play</button>
        const syncPlayLabel = () => playButton.textContent = playing() ? "⏸ Pause" : "▶ Play"
        playButton.onclick = () => {
            if (playing()) {void ctx.suspend().then(syncPlayLabel)} else {
                if (source === null) {startAt(offset)}
                void ctx.resume().then(syncPlayLabel)
            }
        }
        const resetButton: HTMLButtonElement = <button onclick={() => {startAt(0); syncPlayLabel()}}>⏮ Reset</button>
        const cursor: HTMLDivElement = <div className="perf-cursor"/>
        const canvas: HTMLCanvasElement = <canvas width={WAVE_WIDTH} height={WAVE_HEIGHT} className="perf-wave"/>
        drawWaveform(canvas, wasm, "#57c7ff", 1)
        const wrap: HTMLDivElement = <div className="perf-wave-wrap">{canvas}{cursor}</div>
        wrap.onclick = (event: MouseEvent) => {
            const rect = wrap.getBoundingClientRect()
            startAt((event.clientX - rect.left) / rect.width * duration)
            syncPlayLabel()
        }
        const tick = () => {
            cursor.style.left = `${Math.min(100, position() / duration * 100)}%`
            rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
        results.replaceChildren(
            <div className="perf-summary">
                <div className="perf-metric"><span>render</span><strong>{wasm.renderMs.toFixed(1)} ms</strong></div>
                <div className="perf-metric"><span>audio</span><strong>{duration.toFixed(1)} s</strong></div>
                <div className="perf-metric"><span>realtime</span>
                    <strong>{(duration * 1000 / wasm.renderMs).toFixed(1)}×</strong></div>
                <div className="perf-metric"><span>peak</span><strong>{peak.toFixed(4)}</strong></div>
            </div>,
            peak < 1e-4
                ? <p className="perf-active">The render is silent — the project likely starts with silence or uses
                    the clip launcher (which a front-to-end arrangement render does not trigger). Try a longer
                    length, or a bundle whose arrangement has content from the start.</p>
                : <div className="perf-ab">{playButton} {resetButton}</div>,
            <div className="perf-player">{wrap}</div>
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
                buildPlayers(message.wasm)
                status.textContent = `Done. ${message.wasm.renderMs.toFixed(1)} ms (render loop only).`
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
