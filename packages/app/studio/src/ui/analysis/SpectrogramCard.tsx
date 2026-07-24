import {createElement} from "@opendaw/lib-jsx"
import {clamp, isDefined, Lifecycle} from "@opendaw/lib-std"
import {AudioAnalyser, gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {card} from "./AnalysisControls.tsx"
import {observeProject} from "./AnalysisSource.ts"
import {clearBg, FREQ_TICKS, SPEC_X_LOG, unitLabel} from "./AnalysisCommon.ts"

type SpectroBuffer = { canvas: HTMLCanvasElement, w: number, h: number }

const SPECTRO_SILENCE = "hsl(260, 85%, 8%)" // spectrogram color at t=0 (silence), pre-fills the scroll buffer

const pushSpectroColumn = (spectro: SpectroBuffer, width: number, height: number,
                           spectrum: Float32Array, sampleRate: number): void => {
    if (width <= 0 || height <= 0) {return}
    const ctx = spectro.canvas.getContext("2d")
    if (!isDefined(ctx)) {return}
    if (spectro.w !== width || spectro.h !== height) {
        spectro.canvas.width = width
        spectro.canvas.height = height
        spectro.w = width
        spectro.h = height
        ctx.fillStyle = SPECTRO_SILENCE
        ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(spectro.canvas, -1, 0)
    const freqStep = sampleRate / (spectrum.length << 1)
    for (let y = 0; y < height; y++) {
        const freq = SPEC_X_LOG.normToUnit(1.0 - y / height)
        const bin = Math.min(spectrum.length - 1, Math.max(1, Math.round(freq / freqStep)))
        const t = clamp((gainToDb(Math.max(spectrum[bin], 1e-7)) + 96.0) / 96.0, 0.0, 1.0)
        ctx.fillStyle = `hsl(${260 * (1 - t)}, 85%, ${8 + t * 46}%)`
        ctx.fillRect(width - 1, y, 1, 1)
    }
}

const drawSpectro = (painter: CanvasPainter, spectroCanvas: HTMLCanvasElement): void => {
    clearBg(painter)
    const {context, actualHeight: h} = painter
    if (spectroCanvas.width > 0 && spectroCanvas.height > 0) {context.drawImage(spectroCanvas, 0, 0)}
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const yFreq = (freq: number): number => (1.0 - SPEC_X_LOG.unitToNorm(freq)) * h
    let lastY = -1e9
    for (let t = FREQ_TICKS.length - 1; t >= 0; t--) {
        const [freq, label] = FREQ_TICKS[t]
        const top = t === FREQ_TICKS.length - 1
        const bottom = t === 0
        const y = top ? pad : bottom ? h - pad : yFreq(freq)
        if (!top && !bottom && y < lastY + 12 * dpr) {continue}
        unitLabel(context, label, pad, y, "left", top ? "top" : bottom ? "bottom" : "middle")
        lastY = y
    }
}

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const SpectrogramCard = ({lifecycle, service}: Construct): HTMLElement => {
    const spectrum = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const spectro: SpectroBuffer = {canvas: document.createElement("canvas"), w: 0, h: 0}
    const sampleRate = {value: 48000}
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => drawSpectro(painter, spectro.canvas)))
    observeProject(lifecycle, service, (project, runtime) => {
        sampleRate.value = project.engine.sampleRate
        runtime.own(project.liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, values => {
            spectrum.set(values)
            pushSpectroColumn(spectro, painter.actualWidth, Math.round(painter.actualHeight),
                spectrum, sampleRate.value)
            painter.requestUpdate()
        }))
    })
    return card("Spectrogram", [], canvas)
}
