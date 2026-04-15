import css from "./VocoderTransform.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {BiquadCoeff, gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "VocoderTransform")

const MAX_BANDS = 16

// Display axis — fixed 20 Hz to 20 kHz regardless of actual Nyquist.
const F_MIN = 20
const F_MAX = 20000
const LOG_RANGE = Math.log(F_MAX / F_MIN)

const DIVIDERS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

const freqToX = (hz: number, width: number): number =>
    (Math.log(hz / F_MIN) / LOG_RANGE) * width

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: VocoderDeviceBoxAdapter
}

export const VocoderTransform = ({lifecycle, service, adapter}: Construct) => {
    const sampleRate = service.audioContext.sampleRate

    // Scratch buffers — allocated once, reused on every repaint.
    const biquad = new BiquadCoeff()
    const carrierFreq = new Float32Array(MAX_BANDS)
    const modulatorFreq = new Float32Array(MAX_BANDS)
    const qs = new Float32Array(MAX_BANDS)
    let frequency: Float32Array | null = null
    let magResponse: Float32Array | null = null
    let phaseResponse: Float32Array | null = null

    const labels = DIVIDERS.map(hz => {
        const pct = (Math.log(hz / F_MIN) / LOG_RANGE) * 100
        const text = hz < 1000 ? `${hz}` : `${hz / 1000}k`
        return <span style={{left: `${pct.toFixed(2)}%`}}>{text}</span>
    })
    return (
        <div className={className}>
            <div className="freq-labels">{labels}</div>
            <canvas onInit={canvas => {
                const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                    const {context, actualWidth, actualHeight, devicePixelRatio, isResized} = painter
                    const W = actualWidth
                    const H = actualHeight
                    if (W === 0 || H === 0) return

                    // Reallocate frequency arrays on resize
                    if (frequency === null || frequency.length !== W + 1 || isResized) {
                        frequency = new Float32Array(W + 1)
                        magResponse = new Float32Array(W + 1)
                        phaseResponse = new Float32Array(W + 1)
                        for (let k = 0; k <= W; k++) {
                            const hz = F_MIN * Math.exp((k / W) * LOG_RANGE)
                            frequency[k] = hz / sampleRate
                        }
                    }

                    const {
                        carrierMinFreq, carrierMaxFreq, modulatorMinFreq, modulatorMaxFreq, qMin, qMax
                    } = adapter.namedParameter
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

                    // ── Geometry ──
                    // Each half is H/2 tall. Curves fill 80 % of each half, leaving
                    // a 20 %-per-side valley around midline.
                    const h2 = H * 0.5
                    const curveRange = h2 * 0.8
                    const dbRange = 18
                    // Do NOT floor-clamp: at mag → 0, dbToOffset becomes very negative,
                    // so tail strokes end up off-canvas and aren't drawn on the top/bottom
                    // edges. Only defend against +Inf / NaN at the top.
                    const dbToOffset = (db: number) => {
                        if (!isFinite(db) || db > 0) db = db > 0 ? 0 : -1000
                        return ((db + dbRange) / dbRange) * curveRange
                    }
                    const modulatorPeakY = curveRange          // 0 dB Y for modulator
                    const carrierPeakY = H - curveRange        // 0 dB Y for carrier

                    // ── Background grid ──
                    // Horizontal: 0 dB and -9 dB lines for both modulator (top)
                    // and carrier (bottom) halves — 4 lines total.
                    // Vertical: frequency dividers at decade markers.
                    const mod0dB = curveRange                     // modulator 0 dB Y
                    const modMinus9 = curveRange * 0.5            // modulator -9 dB Y
                    const car0dB = H - curveRange                 // carrier 0 dB Y
                    const carMinus9 = H - curveRange * 0.5        // carrier -9 dB Y
                    context.lineWidth = 1
                    context.strokeStyle = "hsla(200, 40%, 70%, 0.10)"
                    context.beginPath()
                    context.moveTo(0, mod0dB); context.lineTo(W, mod0dB)
                    context.moveTo(0, modMinus9); context.lineTo(W, modMinus9)
                    context.moveTo(0, car0dB); context.lineTo(W, car0dB)
                    context.moveTo(0, carMinus9); context.lineTo(W, carMinus9)
                    for (const hz of DIVIDERS) {
                        const x = freqToX(hz, W)
                        context.moveTo(x, 0)
                        context.lineTo(x, H)
                    }
                    context.stroke()

                    context.save()
                    context.globalCompositeOperation = "screen"
                    // 1 device pixel — canvas default. On retina this renders as a
                    // hairline ≈ 0.5 CSS px, matching the reference's subtle stroke.
                    context.lineWidth = 1

                    // Carrier — bottom half. Path starts and ends off-canvas so the
                    // closing horizontal segment at y=H+1 is outside the visible area.
                    // Tails extend below y=H via the unfloored dbToOffset, so the
                    // stroke never touches the bottom edge.
                    for (let i = 0; i < N; i++) {
                        biquad.setBandpassParams(carrierFreq[i] / sampleRate, qs[i])
                        biquad.getFrequencyResponse(frequency, magResponse!, phaseResponse!)
                        const hue = Math.round((i / N) * 360)
                        context.fillStyle = `hsla(${hue}, 50%, 50%, 0.5)`
                        context.strokeStyle = `hsla(${hue}, 50%, 50%, 1.0)`
                        context.beginPath()
                        context.moveTo(-1, H + 2)
                        context.lineTo(-1, H - dbToOffset(gainToDb(magResponse![0])))
                        for (let x = 0; x <= W; x++) {
                            const y = H - dbToOffset(gainToDb(magResponse![x]))
                            context.lineTo(x, y)
                        }
                        context.lineTo(W + 1, H - dbToOffset(gainToDb(magResponse![W])))
                        context.lineTo(W + 1, H + 2)
                        // fill() implicitly closes; stroke() skips the implicit
                        // closing edge, so nothing is drawn along y=H.
                        context.fill()
                        context.stroke()
                    }

                    // Modulator — top half, mirrored.
                    for (let i = 0; i < N; i++) {
                        biquad.setBandpassParams(modulatorFreq[i] / sampleRate, qs[i])
                        biquad.getFrequencyResponse(frequency, magResponse!, phaseResponse!)
                        const hue = Math.round((i / N) * 360)
                        context.fillStyle = `hsla(${hue}, 50%, 50%, 0.5)`
                        context.strokeStyle = `hsla(${hue}, 50%, 50%, 1.0)`
                        context.beginPath()
                        context.moveTo(-1, -2)
                        context.lineTo(-1, dbToOffset(gainToDb(magResponse![0])))
                        for (let x = 0; x <= W; x++) {
                            const y = dbToOffset(gainToDb(magResponse![x]))
                            context.lineTo(x, y)
                        }
                        context.lineTo(W + 1, dbToOffset(gainToDb(magResponse![W])))
                        context.lineTo(W + 1, -2)
                        context.fill()
                        context.stroke()
                    }
                    context.restore()

                    // ── Connection lines: modulator peak Y → carrier peak Y ──
                    context.save()
                    context.lineWidth = devicePixelRatio
                    context.setLineDash([2 * devicePixelRatio, 3 * devicePixelRatio])
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

                    context.restore()
                }))
                lifecycle.ownAll(
                    adapter.namedParameter.carrierMinFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.carrierMaxFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.modulatorMinFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.modulatorMaxFreq.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.qMin.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.namedParameter.qMax.catchupAndSubscribe(() => painter.requestUpdate()),
                    adapter.box.bandCount.catchupAndSubscribe(() => painter.requestUpdate())
                )
            }}/>
        </div>
    )
}
