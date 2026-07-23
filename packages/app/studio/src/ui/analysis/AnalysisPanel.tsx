import css from "./AnalysisPanel.sass?inline"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {clamp, DefaultObservableValue, Lifecycle, Terminator} from "@opendaw/lib-std"
import {AudioAnalyser, gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter, LinearScale, LogScale, Scale} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {VUMeterDesign} from "@/ui/meter/VUMeterDesign"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {Checkbox} from "@/ui/components/Checkbox"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {DropDown} from "@/ui/composite/DropDown"

const className = Html.adoptStyleSheet(css, "AnalysisPanel")

type Construct = { lifecycle: Lifecycle, service: StudioService }

// Mixer Analysis panel. Spectrum, level, scope and VU are driven by the engine's master telemetry
// (EngineAddresses via the LiveStream broadcaster) and only produced while this panel is subscribed,
// i.e. visible/not minimized. Phase, goniometer and loudness are still synthesised dummy data
// (Phase 2 will add their engine DSP).
export const AnalysisPanel = ({lifecycle, service}: Construct) => {
    const spectrum = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const waveform = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const level = {peakL: 0.0, peakR: 0.0, rmsL: 0.0, rmsR: 0.0, lufs: 0.0}
    const stereo = {corr: 0.0, width: 0.0}
    const lufsHistory = new Float32Array(96)
    const vuL = lifecycle.own(new DefaultObservableValue(0.0))
    const vuR = lifecycle.own(new DefaultObservableValue(0.0))
    const gonioHolder = {pairs: new Float32Array(0)}
    const hist = {write: 0, count: 0}
    const sampleRate = {value: 48000}
    const xAxis: Scale = new LogScale(20.0, 20_000.0)
    const yAxis: Scale = new LinearScale(-96.0, 0.0)

    const spectrumCanvas: HTMLCanvasElement = (<canvas/>)
    const levelCanvas: HTMLCanvasElement = (<canvas/>)
    const phaseCanvas: HTMLCanvasElement = (<canvas/>)
    const gonioCanvas: HTMLCanvasElement = (<canvas/>)
    const scopeCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsReadout: HTMLElement = (<span className="readout"/>)

    const spectrumPainter = lifecycle.own(new CanvasPainter(spectrumCanvas,
        painter => drawSpectrum(painter, spectrum, sampleRate.value, xAxis, yAxis)))
    const levelPainter = lifecycle.own(new CanvasPainter(levelCanvas, painter => drawLevel(painter, level)))
    const phasePainter = lifecycle.own(new CanvasPainter(phaseCanvas, painter => drawPhase(painter, stereo)))
    const gonioPainter = lifecycle.own(new CanvasPainter(gonioCanvas, painter => drawGonio(painter, gonioHolder.pairs)))
    const scopePainter = lifecycle.own(new CanvasPainter(scopeCanvas, painter => drawScope(painter, waveform)))
    const lufsPainter = lifecycle.own(new CanvasPainter(lufsCanvas, painter => drawSparkline(painter, lufsHistory)))

    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(optProfile => {
        runtime.terminate()
        optProfile.ifSome(({project}) => {
            const {liveStreamReceiver} = project
            sampleRate.value = project.engine.sampleRate
            runtime.ownAll(
                liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, values => {
                    level.peakL = values[0]
                    level.peakR = values[1]
                    level.rmsL = values[2]
                    level.rmsR = values[3]
                    vuL.setValue(values[0] >= vuL.getValue() ? values[0] : vuL.getValue() * 0.98)
                    vuR.setValue(values[1] >= vuR.getValue() ? values[1] : vuR.getValue() * 0.98)
                    levelPainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, values => {
                    spectrum.set(values)
                    spectrumPainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.WAVEFORM, values => {
                    waveform.set(values)
                    scopePainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.STEREO, values => {
                    stereo.corr = values[0]
                    stereo.width = values[1]
                    phasePainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.GONIO, values => {
                    if (gonioHolder.pairs.length !== values.length) {
                        gonioHolder.pairs = new Float32Array(values.length)
                    }
                    gonioHolder.pairs.set(values)
                    gonioPainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.LOUDNESS, values => {
                    const momentary = values[0]
                    lufsReadout.textContent = `M ${fmtLufs(momentary)} LUFS   S ${fmtLufs(values[1])}   `
                        + `I ${fmtLufs(values[2])}   LRA ${values[3].toFixed(1)} LU   TP ${values[4].toFixed(1)} dBTP`
                    level.lufs = clamp((momentary + 40.0) / 40.0, 0.0, 1.0)
                    if (++hist.count % 6 === 0) {
                        lufsHistory[hist.write] = clamp((values[1] + 40.0) / 40.0, 0.0, 1.0)
                        hist.write = (hist.write + 1) % lufsHistory.length
                    }
                    lufsPainter.requestUpdate()
                    levelPainter.requestUpdate()
                })
            )
        })
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
            {card("VU · R", [],
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
            {cards}
        </div>
    )
    return element
}

const fmtLufs = (value: number): string => value <= -100.0 ? "-∞" : value.toFixed(1)

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

const drawSpectrum = (painter: CanvasPainter, spectrum: Float32Array,
                      sampleRate: number, xAxis: Scale, yAxis: Scale): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const bottomMargin = 12 * dpr
    const plotH = h - bottomMargin
    const numBins = spectrum.length
    const freqStep = sampleRate / (numBins << 1)
    const nyquist = sampleRate * 0.5
    const xOf = (freq: number): number => xAxis.unitToNorm(freq) * w
    const yOf = (gain: number): number => (1.0 - yAxis.unitToNorm(gainToDb(Math.max(gain, 1e-7)))) * plotH
    const yAt = (db: number): number => (1.0 - yAxis.unitToNorm(db)) * plotH
    context.strokeStyle = "rgba(255,255,255,0.05)"
    context.lineWidth = 1
    for (const db of [-30, -60, -90]) {
        const y = yAt(db)
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(w, y)
        context.stroke()
    }
    const firstBin = Math.max(1, Math.ceil(20.0 / freqStep))
    const lastBin = Math.min(numBins - 1, Math.floor(Math.min(20_000.0, nyquist) / freqStep))
    const lastX = xOf(lastBin * freqStep)
    const y0 = yOf(spectrum[firstBin])
    context.beginPath()
    context.moveTo(0, plotH)
    context.lineTo(0, y0)
    for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i]))}
    context.lineTo(lastX, plotH)
    context.closePath()
    const gradient = context.createLinearGradient(0, 0, 0, plotH)
    gradient.addColorStop(0, "rgba(120,190,255,0.5)")
    gradient.addColorStop(1, "rgba(120,190,255,0.04)")
    context.fillStyle = gradient
    context.fill()
    context.strokeStyle = "rgba(150,205,255,0.85)"
    context.lineWidth = 1.5
    context.beginPath()
    context.moveTo(0, y0)
    for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i]))}
    context.stroke()
    unitLabel(context, "0 dB", w - pad, pad, "right", "top")
    unitLabel(context, "-30", w - pad, yAt(-30) + pad, "right", "top")
    unitLabel(context, "-60", w - pad, yAt(-60) + pad, "right", "top")
    const fy = h - dpr
    unitLabel(context, "20 Hz", pad, fy, "left", "bottom")
    unitLabel(context, "100", xOf(100), fy, "center", "bottom")
    unitLabel(context, "1k", xOf(1_000), fy, "center", "bottom")
    unitLabel(context, "10k", xOf(10_000), fy, "center", "bottom")
    unitLabel(context, "20 kHz", w - pad, fy, "right", "bottom")
}

const LEVEL_FLOOR = -60.0
const LEVEL_CEIL = 6.0
const levelNorm = (gain: number): number =>
    clamp((gainToDb(Math.max(gain, 1e-7)) - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR), 0.0, 1.0)

const drawLevel = (painter: CanvasPainter,
                   level: { peakL: number, peakR: number, rmsL: number, rmsR: number, lufs: number }): void => {
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
    drawBar(peakL, levelNorm(level.peakL), -1)
    drawBar(peakR, levelNorm(level.peakR), -1)
    drawBar(rmsL, levelNorm(level.rmsL), -1)
    drawBar(rmsR, levelNorm(level.rmsR), -1)
    drawBar(lufsX, clamp(level.lufs, 0.0, 1.0), -1)
    const yAt = (db: number): number =>
        (1.0 - (db - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR)) * plotH
    unitLabel(context, "0 dBFS", pad, yAt(0), "left", "top")
    unitLabel(context, "-12", pad, yAt(-12), "left", "top")
    unitLabel(context, "-24", pad, yAt(-24), "left", "top")
    unitLabel(context, "-48", pad, yAt(-48), "left", "top")
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

const drawGonio = (painter: CanvasPainter, pairs: Float32Array): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) * 0.4
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.arc(cx, cy, radius, 0, Math.PI * 2)
    context.stroke()
    const count = pairs.length >> 1
    const dot = Math.max(1.0, devicePixelRatio)
    context.fillStyle = "rgba(150,205,255,0.45)"
    for (let k = 0; k < count; k++) {
        const l = pairs[k * 2]
        const r = pairs[k * 2 + 1]
        context.fillRect(cx + (l - r) * 0.5 * radius, cy - (l + r) * 0.5 * radius, dot, dot)
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
        const y = h / 2 - clamp(scope[i] * 0.5, -1.0, 1.0) * (h / 2 - 2)
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
