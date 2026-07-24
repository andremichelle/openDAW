import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle} from "@opendaw/lib-std"
import {AudioAnalyser, gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {card, dropdown, owned, toggle} from "./AnalysisControls.tsx"
import {observeProject} from "./AnalysisSource.ts"
import {clearBg, FREQ_TICKS, SPEC_X_LIN, SPEC_X_LOG, SPEC_Y, unitLabel} from "./AnalysisCommon.ts"

const SPEC_HUE = "hsla(200, 83%, 60%"
const SPEC_TOP_MARGIN = 11.0

const drawSpectrum = (painter: CanvasPainter, spectrum: Float32Array, sampleRate: number,
                      log: boolean, slopeDbOct: number): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const plotTop = SPEC_TOP_MARGIN * dpr
    const plotH = h - plotTop
    const numBins = spectrum.length
    const freqStep = sampleRate / (numBins << 1)
    const nyquist = sampleRate * 0.5
    const xScale = log ? SPEC_X_LOG : SPEC_X_LIN
    const xOf = (freq: number): number => xScale.unitToNorm(freq) * w
    const yOf = (gain: number, freq: number): number => plotTop + (1.0 - SPEC_Y.unitToNorm(
        gainToDb(Math.max(gain, 1e-7)) + slopeDbOct * Math.log2(Math.max(freq, 20.0) / 1000.0))) * plotH
    const yAt = (db: number): number => plotTop + (1.0 - SPEC_Y.unitToNorm(db)) * plotH
    const firstBin = Math.max(1, Math.ceil(20.0 / freqStep))
    const lastBin = Math.min(numBins - 1, Math.floor(Math.min(20_000.0, nyquist) / freqStep))
    const lastX = xOf(lastBin * freqStep)
    const y0 = yOf(spectrum[firstBin], firstBin * freqStep)
    context.beginPath()
    context.moveTo(0, h)
    context.lineTo(0, y0)
    for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i], i * freqStep))}
    context.lineTo(lastX, h)
    context.closePath()
    context.fillStyle = `${SPEC_HUE}, 0.06)`
    context.fill()
    context.strokeStyle = `${SPEC_HUE}, 0.8)`
    context.lineWidth = 1.5
    context.beginPath()
    context.moveTo(0, y0)
    for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i], i * freqStep))}
    context.stroke()
    for (const db of [-20, -40, -60, -80]) {
        unitLabel(context, `${db}`, w - pad, yAt(db), "right", "middle")
    }
    let lastLabelX = -1e9
    for (let t = 0; t < FREQ_TICKS.length; t++) {
        const [freq, label] = FREQ_TICKS[t]
        const first = t === 0
        const last = t === FREQ_TICKS.length - 1
        const x = first ? pad : last ? w - pad : xOf(freq)
        if (!first && !last && x < lastLabelX + 20 * dpr) {continue}
        unitLabel(context, label, x, pad, first ? "left" : last ? "right" : "center", "top")
        lastLabelX = x
    }
}

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const SpectrumCard = ({lifecycle, service}: Construct): HTMLElement => {
    const spectrum = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const specHold = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const sampleRate = {value: 48000}
    const log = owned(lifecycle, true)
    const slope = owned(lifecycle, "4.5 dB/oct")
    const hold = owned(lifecycle, false)
    const avg = owned(lifecycle, false)
    const fft = owned(lifecycle, "4096")
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter =>
        drawSpectrum(painter, spectrum, sampleRate.value, log.getValue(), parseFloat(slope.getValue()))))
    lifecycle.ownAll(
        log.subscribe(painter.requestUpdate),
        slope.subscribe(painter.requestUpdate),
        hold.subscribe(painter.requestUpdate),
        avg.subscribe(painter.requestUpdate)
    )
    lifecycle.own(hold.catchupAndSubscribe(owner => {if (owner.getValue()) {specHold.set(spectrum)}}))
    observeProject(lifecycle, service, (project, runtime) => {
        sampleRate.value = project.engine.sampleRate
        runtime.own(project.liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, values => {
            if (hold.getValue()) {
                for (let i = 0; i < values.length; i++) {
                    if (values[i] > specHold[i]) {specHold[i] = values[i]}
                    spectrum[i] = specHold[i]
                }
            } else if (avg.getValue()) {
                for (let i = 0; i < values.length; i++) {spectrum[i] += (values[i] - spectrum[i]) * 0.2}
            } else {
                spectrum.set(values)
            }
            painter.requestUpdate()
        }))
    })
    return card("Spectrum", [toggle(lifecycle, log, "Log"),
        dropdown(lifecycle, slope, "90px", "0 dB/oct", "3 dB/oct", "4.5 dB/oct", "6 dB/oct"),
        dropdown(lifecycle, fft, "50px", "1024", "2048", "4096", "8192", "16384"),
        toggle(lifecycle, hold, "Hold"), toggle(lifecycle, avg, "Avg")], canvas, true)
}
