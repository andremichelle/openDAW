import css from "./VocoderTransform.sass?inline"
import {Lifecycle, MutableObservableValue, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {BiquadCoeff, gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter, LinearScale, LogScale} from "@opendaw/studio-core"
import {int, linear} from "@opendaw/lib-std"
import {VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "VocoderTransform")

const MAX_BANDS = 16
const F_MIN = 20
const F_MAX = 20000
const LOG_RANGE = Math.log(F_MAX / F_MIN)
const DIVIDERS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const xScale = new LogScale(F_MIN, F_MAX)
const yScale = new LinearScale(-60, -3)

const freqToX = (hz: number, width: number): number =>
    (Math.log(hz / F_MIN) / LOG_RANGE) * width

export const enum DisplayMode {
    Transform = 0,
    Modulator = 1,
    Carrier = 2
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: VocoderDeviceBoxAdapter
    displayMode: MutableObservableValue<number>
    spectrum: Float32Array
}

export const VocoderTransform = ({lifecycle, service, adapter, displayMode, spectrum}: Construct) => {
    const sampleRate = service.audioContext.sampleRate
    const biquad = new BiquadCoeff()
    const carrierFreq = new Float32Array(MAX_BANDS)
    const modulatorFreq = new Float32Array(MAX_BANDS)
    const qs = new Float32Array(MAX_BANDS)
    let frequency: Nullable<Float32Array> = null
    let magResponse: Nullable<Float32Array> = null
    let phaseResponse: Nullable<Float32Array> = null
    const labels = DIVIDERS.map((hz, index) => {
        const pct = (Math.log(hz / F_MIN) / LOG_RANGE) * 100
        const text = hz < 1000 ? `${hz}` : `${hz / 1000}k`
        const isFirst = index === 0
        const isLast = index === DIVIDERS.length - 1
        const anchor = isFirst ? "start" : isLast ? "end" : "center"
        return <span className={anchor} style={{left: `${pct.toFixed(2)}%`}}>{text}</span>
    })
    return (
        <div className={className}>
            <div className="freq-labels">{labels}</div>
            <canvas onInit={canvas => {
                const OVERSAMPLE = 2
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight, isResized} = painter
                    const W = actualWidth
                    const H = actualHeight
                    if (W === 0 || H === 0) return
                    const R = W * OVERSAMPLE
                    if (frequency === null || frequency.length !== R + 1 || isResized) {
                        frequency = new Float32Array(R + 1)
                        magResponse = new Float32Array(R + 1)
                        phaseResponse = new Float32Array(R + 1)
                        for (let k = 0; k <= R; k++) {
                            const hz = F_MIN * Math.exp((k / R) * LOG_RANGE)
                            frequency[k] = hz / sampleRate
                        }
                    }
                    const {carrierMinFreq, carrierMaxFreq, modulatorMinFreq, modulatorMaxFreq, qMin, qMax} = adapter.namedParameter
                    const cfMin = carrierMinFreq.getControlledValue()
                    const cfMax = carrierMaxFreq.getControlledValue()
                    const mfMin = modulatorMinFreq.getControlledValue()
                    const mfMax = modulatorMaxFreq.getControlledValue()
                    const qLo = qMin.getControlledValue()
                    const qHi = qMax.getControlledValue()
                    const N = adapter.box.bandCount.getValue()
                    const cfLog = Math.log(cfMax / cfMin)
                    const mfLog = Math.log(mfMax / mfMin)
                    const qLog = Math.log(qHi / qLo)
                    const denom = N === 1 ? 1 : N - 1
                    for (let i = 0; i < N; i++) {
                        const x = N === 1 ? 0 : i / denom
                        carrierFreq[i] = cfMin * Math.exp(x * cfLog)
                        modulatorFreq[i] = mfMin * Math.exp(x * mfLog)
                        qs[i] = qLo * Math.exp(x * qLog)
                    }
                    context.save()
                    context.clearRect(0, 0, W, H)
                    const h2 = H * 0.5
                    const curveRange = h2 * 0.8
                    const dbRange = 18
                    const dbToOffset = (db: number) => {
                        if (!isFinite(db) || db > 0) db = db > 0 ? 0 : -1000
                        return ((db + dbRange) / dbRange) * curveRange
                    }
                    const modulatorPeakY = curveRange
                    const carrierPeakY = H - curveRange
                    const mod0dB = curveRange
                    const modMinus9 = curveRange * 0.5
                    const car0dB = H - curveRange
                    const carMinus9 = H - curveRange * 0.5
                    context.lineWidth = 1
                    context.strokeStyle = "hsla(200, 40%, 70%, 0.10)"
                    context.beginPath()
                    context.moveTo(0, mod0dB); context.lineTo(W, mod0dB)
                    context.moveTo(0, modMinus9); context.lineTo(W, modMinus9)
                    context.moveTo(0, car0dB); context.lineTo(W, car0dB)
                    context.moveTo(0, carMinus9); context.lineTo(W, carMinus9)
                    for (const hz of DIVIDERS) {
                        const dx = freqToX(hz, W)
                        context.moveTo(dx, 0)
                        context.lineTo(dx, H)
                    }
                    context.stroke()
                    const mode = displayMode.getValue()
                    if (mode === DisplayMode.Modulator || mode === DisplayMode.Carrier) {
                        const numBins = spectrum.length
                        const freqStep = sampleRate / (numBins << 1)
                        let x0: int = 0 | 0
                        let lastEnergy = spectrum[0]
                        let currentEnergy = lastEnergy
                        const spectrumPath = new Path2D()
                        spectrumPath.moveTo(0, (1.0 - yScale.unitToNorm(gainToDb(lastEnergy))) * H)
                        for (let i = 1; i < numBins; ++i) {
                            const energy = spectrum[i]
                            if (currentEnergy < energy) currentEnergy = energy
                            let x1 = (xScale.unitToNorm(i * freqStep) * W) | 0
                            if (x1 > W) { i = numBins; x1 = W }
                            if (x0 < x1) {
                                const xn = x1 - x0
                                const scale = 1.0 / xn
                                const y1 = yScale.unitToNorm(gainToDb(lastEnergy))
                                const y2 = yScale.unitToNorm(gainToDb(currentEnergy))
                                for (let px = 1; px <= xn; ++px) {
                                    spectrumPath.lineTo(x0 + px, (1.0 - linear(y1, y2, px * scale)) * H)
                                }
                                lastEnergy = currentEnergy
                                currentEnergy = 0.0
                            }
                            x0 = x1
                        }
                        context.lineWidth = 0
                        context.strokeStyle = "hsla(200, 83%, 60%, 0.80)"
                        context.stroke(spectrumPath)
                        spectrumPath.lineTo(W, H)
                        spectrumPath.lineTo(0, H)
                        spectrumPath.closePath()
                        context.fillStyle = "hsla(200, 83%, 60%, 0.04)"
                        context.fill(spectrumPath)
                    }
                    const curveAlpha = mode === DisplayMode.Transform ? 1.0 : 0.3
                    context.save()
                    context.globalCompositeOperation = "screen"
                    context.lineWidth = 1
                    const step = 1 / OVERSAMPLE
                    for (let i = 0; i < N; i++) {
                        biquad.setBandpassParams(carrierFreq[i] / sampleRate, qs[i])
                        biquad.getFrequencyResponse(frequency, magResponse!, phaseResponse!)
                        const hue = Math.round((i / N) * 360)
                        context.fillStyle = `hsla(${hue}, 50%, 50%, ${0.5 * curveAlpha})`
                        context.strokeStyle = `hsla(${hue}, 50%, 50%, ${1.0 * curveAlpha})`
                        context.beginPath()
                        context.moveTo(-1, H + 2)
                        context.lineTo(-1, H - dbToOffset(gainToDb(magResponse![0])))
                        for (let k = 0; k <= R; k++) {
                            context.lineTo(k * step, H - dbToOffset(gainToDb(magResponse![k])))
                        }
                        context.lineTo(W + 1, H - dbToOffset(gainToDb(magResponse![R])))
                        context.lineTo(W + 1, H + 2)
                        context.fill()
                        context.stroke()
                    }
                    for (let i = 0; i < N; i++) {
                        biquad.setBandpassParams(modulatorFreq[i] / sampleRate, qs[i])
                        biquad.getFrequencyResponse(frequency, magResponse!, phaseResponse!)
                        const hue = Math.round((i / N) * 360)
                        context.fillStyle = `hsla(${hue}, 50%, 50%, ${0.5 * curveAlpha})`
                        context.strokeStyle = `hsla(${hue}, 50%, 50%, ${1.0 * curveAlpha})`
                        context.beginPath()
                        context.moveTo(-1, -2)
                        context.lineTo(-1, dbToOffset(gainToDb(magResponse![0])))
                        for (let k = 0; k <= R; k++) {
                            context.lineTo(k * step, dbToOffset(gainToDb(magResponse![k])))
                        }
                        context.lineTo(W + 1, dbToOffset(gainToDb(magResponse![R])))
                        context.lineTo(W + 1, -2)
                        context.fill()
                        context.stroke()
                    }
                    context.restore()
                    if (mode === DisplayMode.Transform) {
                        context.save()
                        context.lineWidth = 1
                        context.setLineDash([2, 3])
                        for (let i = 0; i < N; i++) {
                            const hue = Math.round((i / N) * 360)
                            context.strokeStyle = `hsla(${hue}, 80%, 80%, 0.6)`
                            const mx = freqToX(modulatorFreq[i], W)
                            const cx = freqToX(carrierFreq[i], W)
                            context.beginPath()
                            context.moveTo(mx, modulatorPeakY)
                            context.lineTo(cx, carrierPeakY)
                            context.stroke()
                        }
                        context.restore()
                    }
                    context.restore()
                }))
                lifecycle.ownAll(
                    AnimationFrame.add(() => painter.requestUpdate()),
                    adapter.namedParameter.carrierMinFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.carrierMaxFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.modulatorMinFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.modulatorMaxFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.qMin.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.qMax.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.box.bandCount.catchupAndSubscribe(() => painter.requestUpdate()),
                    displayMode.subscribe(() => painter.requestUpdate())
                )
            }}/>
        </div>
    )
}