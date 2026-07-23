import css from "./AnalysisPanel.sass?inline"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {clamp, DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {VUMeterDesign} from "@/ui/meter/VUMeterDesign"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {Checkbox} from "@/ui/components/Checkbox"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {DropDown} from "@/ui/composite/DropDown"

const className = Html.adoptStyleSheet(css, "AnalysisPanel")

type Construct = { lifecycle: Lifecycle, service: StudioService }

// Dummy-data preview of the mixer Analysis panel. Values are synthesised on the animation frame so
// the responsive layout can be exercised without engine telemetry.
export const AnalysisPanel = ({lifecycle, service: _service}: Construct) => {
    const bins = new Float32Array(112)
    const scope = new Float32Array(256)
    const level = {l: 0.0, r: 0.0, pkL: 0.0, pkR: 0.0, rmsL: 0.0, rmsR: 0.0, lufs: 0.0}
    const stereo = {corr: 0.0, width: 0.0}
    const lufsHistory = new Float32Array(96)
    const vuL = lifecycle.own(new DefaultObservableValue(0.0))
    const vuR = lifecycle.own(new DefaultObservableValue(0.0))
    const clock = {t: 0.0}

    const spectrumCanvas: HTMLCanvasElement = (<canvas/>)
    const levelCanvas: HTMLCanvasElement = (<canvas/>)
    const phaseCanvas: HTMLCanvasElement = (<canvas/>)
    const gonioCanvas: HTMLCanvasElement = (<canvas/>)
    const scopeCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsReadout: HTMLElement = (<span className="readout"/>)

    const painters = [
        lifecycle.own(new CanvasPainter(spectrumCanvas, painter => drawSpectrum(painter, bins))),
        lifecycle.own(new CanvasPainter(levelCanvas, painter => drawLevel(painter, level))),
        lifecycle.own(new CanvasPainter(phaseCanvas, painter => drawPhase(painter, stereo))),
        lifecycle.own(new CanvasPainter(gonioCanvas, painter => drawGonio(painter, clock.t))),
        lifecycle.own(new CanvasPainter(scopeCanvas, painter => drawScope(painter, scope))),
        lifecycle.own(new CanvasPainter(lufsCanvas, painter => drawSparkline(painter, lufsHistory)))
    ]

    lifecycle.own(AnimationFrame.add(() => {
        clock.t += 1.0 / 60.0
        updateDummy(clock.t, bins, scope, level, stereo, lufsHistory)
        vuL.setValue(0.28 + 0.55 * Math.abs(Math.sin(clock.t * 1.7)))
        vuR.setValue(0.28 + 0.55 * Math.abs(Math.sin(clock.t * 1.7 + 0.6)))
        lufsReadout.textContent = `M ${(-14 + Math.sin(clock.t) * 1.5).toFixed(1)} LUFS   `
            + `S -13.8   I -15.1   LRA 6.2 LU   TP -1.0 dBTP`
        painters.forEach(painter => painter.requestUpdate())
    }))

    const toggle = (label: string, initial: boolean = false): HTMLElement => {
        const model = lifecycle.own(new DefaultObservableValue(initial))
        return (
            <Checkbox lifecycle={lifecycle} model={model}>
                <span>{label}</span>
            </Checkbox>
        )
    }
    const radio = (initial: string, ...options: ReadonlyArray<string>): HTMLElement => {
        const model = lifecycle.own(new DefaultObservableValue(initial))
        return (
            <RadioGroup lifecycle={lifecycle} model={model}
                        elements={options.map(label => ({value: label, element: (<span>{label}</span>)}))}/>
        )
    }
    const dropdown = (width: string, initial: string, ...options: ReadonlyArray<string>): HTMLElement => {
        const model = lifecycle.own(new DefaultObservableValue(initial))
        return (
            <DropDown lifecycle={lifecycle} owner={model} provider={() => options}
                      mapping={value => value} appearance={{color: Colors.gray}} width={width}/>
        )
    }
    const action = (label: string): HTMLElement => (<span className="control action">{label}</span>)

    const card = (title: string, controlRow: JsxValue, body: JsxValue,
                  full: boolean = false, cardClass: string = ""): HTMLElement => (
        <div className={Html.buildClassList("card", full && "full", cardClass)}>
            <div className="card-head">
                <span className="title">{title}</span>
                <span className="controls">{controlRow}</span>
            </div>
            <div className="card-body">{body}</div>
        </div>
    )

    const cards: HTMLElement = (
        <div className="cards" onConnect={host => lifecycle.own(installScrollbars(host))}>
            {card("VU · L", dropdown("6.5em", "-18 dBFS", "-12 dBFS", "-14 dBFS", "-16 dBFS",
                "-18 dBFS", "-20 dBFS", "-22 dBFS"),
                (<div className="vu"><VUMeterDesign.Default model={vuL}/></div>), false, "meter")}
            {card("VU · R", toggle("Mono"),
                (<div className="vu"><VUMeterDesign.Default model={vuR}/></div>), false, "meter")}
            {card("Spectrum", [radio("Line", "Line", "Bars", "Spectro"), toggle("Log", true),
                dropdown("8em", "4.5 dB/oct", "0 dB/oct", "3 dB/oct", "4.5 dB/oct", "6 dB/oct"),
                dropdown("4.5em", "4096", "1024", "2048", "4096", "8192", "16384"),
                toggle("Hold"), toggle("Avg")], spectrumCanvas, true)}
            {card("Level", [radio("dBFS", "dBFS", "K-14", "K-20"), toggle("TP"), toggle("Hold")], levelCanvas)}
            {card("Phase", radio("300 ms", "100 ms", "300 ms", "1 s"), phaseCanvas)}
            {card("Gonio", [radio("L/R", "L/R", "M/S"), toggle("Fade", true)], gonioCanvas)}
            {card("Scope", [toggle("Trig"), radio("10 ms", "10 ms", "50 ms", "100 ms")], scopeCanvas)}
            {card("Loudness", [radio("R128", "R128", "K"), action("reset")],
                (<div className="lufs">{lufsReadout}{lufsCanvas}</div>), true)}
        </div>
    )

    const element: HTMLElement = (
        <div className={className}>
            <div className="toolbar">
                <span className="source">Master</span>
                <span className="spacer"/>
                <span className="control">settings</span>
            </div>
            {cards}
        </div>
    )
    return element
}

const updateDummy = (t: number, bins: Float32Array, scope: Float32Array,
                     level: {
                         l: number, r: number, pkL: number, pkR: number,
                         rmsL: number, rmsR: number, lufs: number
                     },
                     stereo: { corr: number, width: number },
                     lufsHistory: Float32Array): void => {
    for (let i = 0; i < bins.length; i++) {
        const f = i / bins.length
        const tilt = Math.pow(1.0 - f, 1.4)
        const wobble = 0.5 + 0.5 * Math.sin(t * 2.0 + i * 0.35)
        const target = clamp(tilt * (0.35 + 0.6 * wobble * (0.4 + 0.6 * pseudoNoise(i, t))), 0.0, 1.0)
        bins[i] += (target - bins[i]) * 0.35
    }
    for (let i = 0; i < scope.length; i++) {
        const p = i / scope.length
        scope[i] = Math.sin(p * Math.PI * 6.0 + t * 5.0) * 0.7 * (0.6 + 0.4 * Math.sin(t * 0.8))
    }
    level.l = clamp(0.5 + 0.45 * Math.sin(t * 2.3), 0.0, 1.0)
    level.r = clamp(0.5 + 0.45 * Math.sin(t * 2.3 + 0.7), 0.0, 1.0)
    level.pkL = level.l > level.pkL ? level.l : level.pkL * 0.985
    level.pkR = level.r > level.pkR ? level.r : level.pkR * 0.985
    level.rmsL += (level.l * 0.72 - level.rmsL) * 0.06
    level.rmsR += (level.r * 0.72 - level.rmsR) * 0.06
    level.lufs += ((level.l + level.r) * 0.5 * 0.66 - level.lufs) * 0.02
    stereo.corr = Math.sin(t * 0.7)
    stereo.width = 0.5 + 0.4 * Math.sin(t * 0.5)
    const head = (Math.floor(t * 12) % lufsHistory.length + lufsHistory.length) % lufsHistory.length
    lufsHistory[head] = 0.5 + 0.4 * Math.sin(t * 1.3)
}

const pseudoNoise = (i: number, t: number): number => {
    const value = Math.sin(i * 12.9898 + Math.floor(t * 8.0) * 78.233) * 43758.5453
    return value - Math.floor(value)
}

const clearBg = ({context, actualWidth, actualHeight}: CanvasPainter): void =>
    context.clearRect(0, 0, actualWidth, actualHeight)

const UNIT_COLOR = "rgba(255,255,255,0.3)"

const unitLabel = (context: CanvasRenderingContext2D, text: string, x: number, y: number,
                   align: CanvasTextAlign, baseline: CanvasTextBaseline): void => {
    context.fillStyle = UNIT_COLOR
    context.font = `${Math.round(8 * devicePixelRatio)}px sans-serif`
    context.textAlign = align
    context.textBaseline = baseline
    context.fillText(text, x, y)
}

const drawSpectrum = (painter: CanvasPainter, bins: Float32Array): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const bottomMargin = 12 * dpr
    const plotH = h - bottomMargin
    context.strokeStyle = "rgba(255,255,255,0.05)"
    context.lineWidth = 1
    for (let row = 1; row < 4; row++) {
        const y = (plotH * row) / 4
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(w, y)
        context.stroke()
    }
    context.beginPath()
    context.moveTo(0, plotH)
    for (let i = 0; i < bins.length; i++) {
        context.lineTo((i / (bins.length - 1)) * w, plotH - bins[i] * (plotH - 2))
    }
    context.lineTo(w, plotH)
    context.closePath()
    const gradient = context.createLinearGradient(0, 0, 0, plotH)
    gradient.addColorStop(0, "rgba(120,190,255,0.5)")
    gradient.addColorStop(1, "rgba(120,190,255,0.04)")
    context.fillStyle = gradient
    context.fill()
    context.strokeStyle = "rgba(150,205,255,0.85)"
    context.lineWidth = 1.5
    context.beginPath()
    for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * w
        const y = plotH - bins[i] * (plotH - 2)
        if (i === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
    }
    context.stroke()
    const pad = 3 * dpr
    unitLabel(context, "0 dB", w - pad, pad, "right", "top")
    unitLabel(context, "-30", w - pad, plotH / 4 + pad, "right", "top")
    unitLabel(context, "-60", w - pad, plotH / 2 + pad, "right", "top")
    const fy = h - dpr
    unitLabel(context, "20 Hz", pad, fy, "left", "bottom")
    unitLabel(context, "100", w * 0.24, fy, "center", "bottom")
    unitLabel(context, "1k", w * 0.5, fy, "center", "bottom")
    unitLabel(context, "10k", w * 0.78, fy, "center", "bottom")
    unitLabel(context, "20 kHz", w - pad, fy, "right", "bottom")
}

const drawLevel = (painter: CanvasPainter,
                   level: {
                       l: number, r: number, pkL: number, pkR: number,
                       rmsL: number, rmsR: number, lufs: number
                   }): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const bottomMargin = 12 * dpr
    const plotH = h - bottomMargin
    const scaleW = 32 * dpr
    const pairGap = 5 * dpr
    const groupGap = 15 * dpr
    const areaStart = scaleW
    const area = w - pad - areaStart
    const barWidth = Math.min((area - 2 * pairGap - 2 * groupGap) / 5, 26 * dpr)
    const clusterWidth = 5 * barWidth + 2 * pairGap + 2 * groupGap
    const x0 = areaStart + (area - clusterWidth) / 2
    const drawBar = (x: number, value: number, peak: number) => {
        context.fillStyle = "rgba(255,255,255,0.06)"
        context.fillRect(x, 0, barWidth, plotH)
        const gradient = context.createLinearGradient(0, plotH, 0, 0)
        gradient.addColorStop(0, "hsl(140,55%,45%)")
        gradient.addColorStop(0.7, "hsl(60,65%,50%)")
        gradient.addColorStop(1, "hsl(8,72%,52%)")
        context.fillStyle = gradient
        context.fillRect(x, plotH - value * plotH, barWidth, value * plotH)
        if (peak >= 0) {
            context.fillStyle = "rgba(255,255,255,0.85)"
            context.fillRect(x, plotH - peak * plotH - 1, barWidth, 2)
        }
    }
    const peakL = x0
    const peakR = peakL + barWidth + pairGap
    const rmsL = peakR + barWidth + groupGap
    const rmsR = rmsL + barWidth + pairGap
    const lufsX = rmsR + barWidth + groupGap
    drawBar(peakL, level.l, level.pkL)
    drawBar(peakR, level.r, level.pkR)
    drawBar(rmsL, level.rmsL, -1)
    drawBar(rmsR, level.rmsR, -1)
    drawBar(lufsX, level.lufs, -1)
    unitLabel(context, "0 dBFS", pad, pad, "left", "top")
    unitLabel(context, "-12", pad, plotH * 0.25, "left", "top")
    unitLabel(context, "-24", pad, plotH * 0.5, "left", "top")
    unitLabel(context, "-48", pad, plotH * 0.75, "left", "top")
    unitLabel(context, "peak L R", (peakL + peakR + barWidth) / 2, h - dpr, "center", "bottom")
    unitLabel(context, "rms L R", (rmsL + rmsR + barWidth) / 2, h - dpr, "center", "bottom")
    unitLabel(context, "LUFS M", lufsX + barWidth / 2, h - dpr, "center", "bottom")
}

const drawPhase = (painter: CanvasPainter, stereo: { corr: number, width: number }): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const pad = 3 * devicePixelRatio
    const midY = h * 0.44
    context.strokeStyle = "rgba(255,255,255,0.15)"
    context.beginPath()
    context.moveTo(pad, midY)
    context.lineTo(w - pad, midY)
    context.stroke()
    const cx = pad + ((stereo.corr + 1) / 2) * (w - pad * 2)
    context.fillStyle = stereo.corr < 0 ? "hsl(8,72%,55%)" : "hsl(140,55%,55%)"
    context.beginPath()
    context.arc(cx, midY, 5 * devicePixelRatio, 0, Math.PI * 2)
    context.fill()
    const barY = h * 0.74
    context.fillStyle = "rgba(255,255,255,0.08)"
    context.fillRect(pad, barY, w - pad * 2, 6 * devicePixelRatio)
    context.fillStyle = "hsl(200,65%,60%)"
    context.fillRect(pad, barY, (w - pad * 2) * clamp(stereo.width, 0, 1), 6 * devicePixelRatio)
    unitLabel(context, "corr -1", pad, pad, "left", "top")
    unitLabel(context, "+1", w - pad, pad, "right", "top")
    unitLabel(context, "width 0..1", pad, h - pad, "left", "bottom")
}

const drawGonio = (painter: CanvasPainter, t: number): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) * 0.4
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.arc(cx, cy, radius, 0, Math.PI * 2)
    context.stroke()
    const count = 220
    for (let k = 0; k < count; k++) {
        const p = k / count
        const phase = t * 2.0 + p * Math.PI * 2.0 * 3.0
        const l = Math.sin(phase)
        const r = Math.sin(phase * 1.01 + Math.sin(t) * 0.8)
        context.fillStyle = `rgba(150,205,255,${0.12 + 0.5 * p})`
        context.fillRect(cx + ((l - r) / 2) * radius, cy - ((l + r) / 2) * radius, 2, 2)
    }
    const pad = 3 * devicePixelRatio
    unitLabel(context, "M", cx, cy - radius - 3 * devicePixelRatio, "center", "bottom")
    unitLabel(context, "S", w - pad, cy, "right", "middle")
    unitLabel(context, "L", cx - radius, cy - radius, "right", "bottom")
    unitLabel(context, "R", cx + radius, cy - radius, "left", "bottom")
}

const drawScope = (painter: CanvasPainter, scope: Float32Array): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.moveTo(0, h / 2)
    context.lineTo(w, h / 2)
    context.stroke()
    context.strokeStyle = "hsl(150,65%,60%)"
    context.lineWidth = 1.5
    context.beginPath()
    for (let i = 0; i < scope.length; i++) {
        const x = (i / (scope.length - 1)) * w
        const y = h / 2 - scope[i] * (h / 2 - 2)
        if (i === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
    }
    context.stroke()
    const pad = 3 * devicePixelRatio
    unitLabel(context, "+1", pad, pad, "left", "top")
    unitLabel(context, "-1", pad, h - pad, "left", "bottom")
    unitLabel(context, "10 ms/div", w - pad, h - pad, "right", "bottom")
}

const drawSparkline = (painter: CanvasPainter, history: Float32Array): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    context.strokeStyle = "hsl(40,75%,60%)"
    context.lineWidth = 1.5
    context.beginPath()
    for (let i = 0; i < history.length; i++) {
        const x = (i / (history.length - 1)) * w
        const y = h - history[i] * (h - 2)
        if (i === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
    }
    context.stroke()
}
