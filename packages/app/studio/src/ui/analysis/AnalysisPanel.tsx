import css from "./AnalysisPanel.sass?inline"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {clamp, DefaultObservableValue, isDefined, Lifecycle, MutableObservableValue, Terminator} from "@opendaw/lib-std"
import {AudioAnalyser, dbToGain, gainToDb} from "@opendaw/lib-dsp"
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
    const specHold = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const spectro = {canvas: document.createElement("canvas"), w: 0, h: 0}

    const spectrumMode = lifecycle.own(new DefaultObservableValue("Line"))
    const spectrumLog = lifecycle.own(new DefaultObservableValue(true))
    const spectrumSlope = lifecycle.own(new DefaultObservableValue("4.5 dB/oct"))
    const spectrumHold = lifecycle.own(new DefaultObservableValue(false))
    const spectrumAvg = lifecycle.own(new DefaultObservableValue(false))
    const levelScale = lifecycle.own(new DefaultObservableValue("dBFS"))
    const gonioMode = lifecycle.own(new DefaultObservableValue("L/R"))
    const gonioFade = lifecycle.own(new DefaultObservableValue(true))
    const vuRef = lifecycle.own(new DefaultObservableValue("0 dBFS"))
    const scopeTrig = lifecycle.own(new DefaultObservableValue(false))
    const vuRefGain = {value: 1.0}
    lifecycle.own(vuRef.catchupAndSubscribe(owner => vuRefGain.value = dbToGain(-parseFloat(owner.getValue()))))
    lifecycle.own(spectrumHold.catchupAndSubscribe(owner => {if (owner.getValue()) {specHold.set(spectrum)}}))

    const spectrumCanvas: HTMLCanvasElement = (<canvas/>)
    const levelCanvas: HTMLCanvasElement = (<canvas/>)
    const phaseCanvas: HTMLCanvasElement = (<canvas/>)
    const gonioCanvas: HTMLCanvasElement = (<canvas/>)
    const scopeCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsCanvas: HTMLCanvasElement = (<canvas/>)
    const lufsReadout: HTMLElement = (<span className="readout"/>)

    const spectrumPainter = lifecycle.own(new CanvasPainter(spectrumCanvas, painter =>
        drawSpectrum(painter, spectrum, sampleRate.value, spectrumLog.getValue(),
            parseFloat(spectrumSlope.getValue()), spectrumMode.getValue(), spectro.canvas)))
    const levelPainter = lifecycle.own(new CanvasPainter(levelCanvas,
        painter => drawLevel(painter, level, levelScale.getValue())))
    const phasePainter = lifecycle.own(new CanvasPainter(phaseCanvas, painter => drawPhase(painter, stereo)))
    const gonioPainter = lifecycle.own(new CanvasPainter(gonioCanvas,
        painter => drawGonio(painter, gonioHolder.pairs, gonioMode.getValue(), gonioFade.getValue())))
    const scopePainter = lifecycle.own(new CanvasPainter(scopeCanvas,
        painter => drawScope(painter, waveform, scopeTrig.getValue())))
    const lufsPainter = lifecycle.own(new CanvasPainter(lufsCanvas, painter => drawSparkline(painter, lufsHistory)))
    lifecycle.ownAll(
        spectrumMode.subscribe(spectrumPainter.requestUpdate),
        spectrumLog.subscribe(spectrumPainter.requestUpdate),
        spectrumSlope.subscribe(spectrumPainter.requestUpdate),
        spectrumHold.subscribe(spectrumPainter.requestUpdate),
        spectrumAvg.subscribe(spectrumPainter.requestUpdate),
        levelScale.subscribe(levelPainter.requestUpdate),
        gonioMode.subscribe(gonioPainter.requestUpdate),
        gonioFade.subscribe(gonioPainter.requestUpdate),
        scopeTrig.subscribe(scopePainter.requestUpdate)
    )

    const pushSpectroColumn = (): void => {
        const w = spectrumPainter.actualWidth
        const ph = Math.round(spectrumPainter.actualHeight - 12 * devicePixelRatio)
        if (w <= 0 || ph <= 0) {return}
        if (spectro.w !== w || spectro.h !== ph) {
            spectro.canvas.width = w
            spectro.canvas.height = ph
            spectro.w = w
            spectro.h = ph
        }
        const ctx = spectro.canvas.getContext("2d")
        if (!isDefined(ctx)) {return}
        ctx.drawImage(spectro.canvas, -1, 0)
        const freqStep = sampleRate.value / (spectrum.length << 1)
        for (let y = 0; y < ph; y++) {
            const freq = SPEC_X_LOG.normToUnit(1.0 - y / ph)
            const bin = Math.min(spectrum.length - 1, Math.max(1, Math.round(freq / freqStep)))
            const t = clamp((gainToDb(Math.max(spectrum[bin], 1e-7)) + 96.0) / 96.0, 0.0, 1.0)
            ctx.fillStyle = `hsl(${260 * (1 - t)}, 85%, ${8 + t * 46}%)`
            ctx.fillRect(w - 1, y, 1, 1)
        }
    }

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
                    const targetL = values[2] * vuRefGain.value
                    const targetR = values[3] * vuRefGain.value
                    vuL.setValue(vuL.getValue() + (targetL - vuL.getValue()) * 0.1)
                    vuR.setValue(vuR.getValue() + (targetR - vuR.getValue()) * 0.1)
                    levelPainter.requestUpdate()
                }),
                liveStreamReceiver.subscribeFloats(EngineAddresses.SPECTRUM, values => {
                    if (spectrumHold.getValue()) {
                        for (let i = 0; i < values.length; i++) {
                            if (values[i] > specHold[i]) {specHold[i] = values[i]}
                            spectrum[i] = specHold[i]
                        }
                    } else if (spectrumAvg.getValue()) {
                        for (let i = 0; i < values.length; i++) {spectrum[i] += (values[i] - spectrum[i]) * 0.2}
                    } else {
                        spectrum.set(values)
                    }
                    if (spectrumMode.getValue() === "Spectro") {pushSpectroColumn()}
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

    const toggle = (model: MutableObservableValue<boolean>, label: string): HTMLElement => (
        <Checkbox lifecycle={lifecycle} model={model}>
            <span>{label}</span>
        </Checkbox>
    )
    const radio = (model: MutableObservableValue<string>, ...options: ReadonlyArray<string>): HTMLElement => (
        <RadioGroup lifecycle={lifecycle} model={model}
                    elements={options.map(label => ({value: label, element: (<span>{label}</span>)}))}/>
    )
    const dropdown = (model: MutableObservableValue<string>, width: string,
                      ...options: ReadonlyArray<string>): HTMLElement => (
        <DropDown lifecycle={lifecycle} owner={model} provider={() => options}
                  mapping={value => value} appearance={{color: Colors.gray}} width={width}/>
    )
    const pendingBool = (initial: boolean = false): MutableObservableValue<boolean> =>
        lifecycle.own(new DefaultObservableValue(initial))
    const pendingStr = (initial: string): MutableObservableValue<string> =>
        lifecycle.own(new DefaultObservableValue(initial))
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
            {card("VU · L", dropdown(vuRef, "6.5em", "0 dBFS", "-14 dBFS", "-18 dBFS", "-20 dBFS"),
                (<div className="vu"><VUMeterDesign.Default model={vuL}/></div>), false, "meter")}
            {card("VU · R", [],
                (<div className="vu"><VUMeterDesign.Default model={vuR}/></div>), false, "meter")}
            {card("Spectrum", [radio(spectrumMode, "Line", "Bars", "Spectro"), toggle(spectrumLog, "Log"),
                dropdown(spectrumSlope, "8em", "0 dB/oct", "3 dB/oct", "4.5 dB/oct", "6 dB/oct"),
                dropdown(pendingStr("4096"), "4.5em", "1024", "2048", "4096", "8192", "16384"),
                toggle(spectrumHold, "Hold"), toggle(spectrumAvg, "Avg")], spectrumCanvas, true)}
            {card("Level", [radio(levelScale, "dBFS", "K-14", "K-20"), toggle(pendingBool(), "TP"),
                toggle(pendingBool(), "Hold")], levelCanvas)}
            {card("Phase", radio(pendingStr("300 ms"), "100 ms", "300 ms", "1 s"), phaseCanvas)}
            {card("Gonio", [radio(gonioMode, "L/R", "M/S"), toggle(gonioFade, "Fade")], gonioCanvas)}
            {card("Scope", [toggle(scopeTrig, "Trig"), radio(pendingStr("10 ms"), "10 ms", "50 ms", "100 ms")],
                scopeCanvas)}
            {card("Loudness", [radio(pendingStr("R128"), "R128", "K"), action("reset")],
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

const SPEC_Y: Scale = new LinearScale(-96.0, 0.0)
const SPEC_X_LOG: Scale = new LogScale(20.0, 20_000.0)
const SPEC_X_LIN: Scale = new LinearScale(20.0, 20_000.0)
const FREQ_TICKS: ReadonlyArray<readonly [number, string]> = [
    [20, "20"], [50, "50"], [100, "100"], [200, "200"], [500, "500"],
    [1_000, "1k"], [2_000, "2k"], [5_000, "5k"], [10_000, "10k"], [20_000, "20k"]
]

const drawSpectrum = (painter: CanvasPainter, spectrum: Float32Array, sampleRate: number,
                      log: boolean, slopeDbOct: number, mode: string, spectroCanvas: HTMLCanvasElement): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const bottomMargin = 12 * dpr
    const plotH = h - bottomMargin
    const numBins = spectrum.length
    const freqStep = sampleRate / (numBins << 1)
    const nyquist = sampleRate * 0.5
    const xScale = log ? SPEC_X_LOG : SPEC_X_LIN
    const xOf = (freq: number): number => xScale.unitToNorm(freq) * w
    const yOf = (gain: number, freq: number): number => (1.0 - SPEC_Y.unitToNorm(
        gainToDb(Math.max(gain, 1e-7)) + slopeDbOct * Math.log2(Math.max(freq, 20.0) / 1000.0))) * plotH
    const yAt = (db: number): number => (1.0 - SPEC_Y.unitToNorm(db)) * plotH
    if (mode !== "Spectro") {
        context.strokeStyle = "rgba(255,255,255,0.05)"
        context.lineWidth = 1
        for (const db of [-30, -60, -90]) {
            const y = yAt(db)
            context.beginPath()
            context.moveTo(0, y)
            context.lineTo(w, y)
            context.stroke()
        }
    }
    const firstBin = Math.max(1, Math.ceil(20.0 / freqStep))
    const lastBin = Math.min(numBins - 1, Math.floor(Math.min(20_000.0, nyquist) / freqStep))
    if (mode === "Spectro") {
        if (spectroCanvas.width > 0 && spectroCanvas.height > 0) {context.drawImage(spectroCanvas, 0, 0)}
    } else if (mode === "Bars") {
        const bands = 56
        context.fillStyle = "rgba(140,195,255,0.7)"
        for (let b = 0; b < bands; b++) {
            const f0 = 20.0 * Math.pow(1000.0, b / bands)
            const f1 = 20.0 * Math.pow(1000.0, (b + 1) / bands)
            const i0 = Math.max(1, Math.floor(f0 / freqStep))
            const i1 = Math.min(numBins - 1, Math.ceil(f1 / freqStep))
            let mag = 0.0
            for (let i = i0; i <= i1; i++) {if (spectrum[i] > mag) {mag = spectrum[i]}}
            const x0b = xOf(f0)
            const y = yOf(mag, (f0 + f1) * 0.5)
            context.fillRect(x0b, y, Math.max(1.0, xOf(f1) - x0b - dpr), plotH - y)
        }
    } else {
        const lastX = xOf(lastBin * freqStep)
        const y0 = yOf(spectrum[firstBin], firstBin * freqStep)
        context.beginPath()
        context.moveTo(0, plotH)
        context.lineTo(0, y0)
        for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i], i * freqStep))}
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
        for (let i = firstBin; i <= lastBin; i++) {context.lineTo(xOf(i * freqStep), yOf(spectrum[i], i * freqStep))}
        context.stroke()
    }
    if (mode === "Spectro") {
        const yFreq = (freq: number): number => (1.0 - SPEC_X_LOG.unitToNorm(freq)) * plotH
        let lastY = -1e9
        for (let t = FREQ_TICKS.length - 1; t >= 0; t--) {
            const [freq, label] = FREQ_TICKS[t]
            const top = t === FREQ_TICKS.length - 1
            const bottom = t === 0
            const y = top ? pad : bottom ? plotH - pad : yFreq(freq)
            if (!top && !bottom && y < lastY + 12 * dpr) {continue}
            unitLabel(context, label, pad, y, "left", top ? "top" : bottom ? "bottom" : "middle")
            lastY = y
        }
    } else {
        unitLabel(context, "0 dB", w - pad, pad, "right", "top")
        unitLabel(context, "-30", w - pad, yAt(-30) + pad, "right", "top")
        unitLabel(context, "-60", w - pad, yAt(-60) + pad, "right", "top")
        const fy = h - dpr
        let lastX = -1e9
        for (let t = 0; t < FREQ_TICKS.length; t++) {
            const [freq, label] = FREQ_TICKS[t]
            const first = t === 0
            const last = t === FREQ_TICKS.length - 1
            const x = first ? pad : last ? w - pad : xOf(freq)
            if (!first && !last && x < lastX + 20 * dpr) {continue}
            unitLabel(context, label, x, fy, first ? "left" : last ? "right" : "center", "bottom")
            lastX = x
        }
    }
}

const LEVEL_FLOOR = -40.0
const LEVEL_CEIL = 14.0
const LEVEL_SCALES: Record<string, { off: number, ticks: ReadonlyArray<number>, unit: string }> = {
    "dBFS": {off: 0.0, ticks: [0, -12, -24, -36], unit: "dBFS"},
    "K-14": {off: 14.0, ticks: [8, 0, -8, -16], unit: "K"},
    "K-20": {off: 20.0, ticks: [6, 0, -10, -20], unit: "K"}
}
const levelNorm = (gain: number, off: number): number =>
    clamp((gainToDb(Math.max(gain, 1e-7)) + off - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR), 0.0, 1.0)

const drawLevel = (painter: CanvasPainter,
                   level: { peakL: number, peakR: number, rmsL: number, rmsR: number, lufs: number },
                   scale: string): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const dpr = devicePixelRatio
    const pad = 3 * dpr
    const bottomMargin = 12 * dpr
    const plotH = h - bottomMargin
    const off = (LEVEL_SCALES[scale] ?? LEVEL_SCALES["dBFS"]).off
    const spec = LEVEL_SCALES[scale] ?? LEVEL_SCALES["dBFS"]
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
    drawBar(peakL, levelNorm(level.peakL, off), -1)
    drawBar(peakR, levelNorm(level.peakR, off), -1)
    drawBar(rmsL, levelNorm(level.rmsL, off), -1)
    drawBar(rmsR, levelNorm(level.rmsR, off), -1)
    drawBar(lufsX, clamp(level.lufs, 0.0, 1.0), -1)
    const yAt = (db: number): number =>
        (1.0 - (db - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR)) * plotH
    spec.ticks.forEach((tick, index) =>
        unitLabel(context, index === 0 ? `${tick} ${spec.unit}` : `${tick}`, pad, yAt(tick), "left", "top"))
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

const drawGonio = (painter: CanvasPainter, pairs: Float32Array, mode: string, fade: boolean): void => {
    const {context, actualWidth: w, actualHeight: h} = painter
    if (fade) {
        context.fillStyle = "rgba(0,0,0,0.12)"
        context.fillRect(0, 0, w, h)
    } else {
        clearBg(painter)
    }
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) * 0.4
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.arc(cx, cy, radius, 0, Math.PI * 2)
    context.stroke()
    const midSide = mode === "M/S"
    const count = pairs.length >> 1
    const dot = Math.max(1.0, devicePixelRatio)
    context.fillStyle = "rgba(150,205,255,0.5)"
    for (let k = 0; k < count; k++) {
        const l = pairs[k * 2]
        const r = pairs[k * 2 + 1]
        const x = midSide ? cx + (l - r) * 0.5 * radius : cx + l * radius
        const y = midSide ? cy - (l + r) * 0.5 * radius : cy - r * radius
        context.fillRect(x, y, dot, dot)
    }
    const pad = 3 * devicePixelRatio
    if (midSide) {
        unitLabel(context, "M", cx, cy - radius - 3 * devicePixelRatio, "center", "bottom")
        unitLabel(context, "S", w - pad, cy, "right", "middle")
        unitLabel(context, "L", cx - radius, cy - radius, "right", "bottom")
        unitLabel(context, "R", cx + radius, cy - radius, "left", "bottom")
    } else {
        unitLabel(context, "L", w - pad, cy, "right", "middle")
        unitLabel(context, "R", cx, cy - radius - 3 * devicePixelRatio, "center", "bottom")
    }
}

const triggerIndex = (waveform: Float32Array): number => {
    for (let i = 1; i < waveform.length; i++) {
        if (waveform[i - 1] <= 0.0 && waveform[i] > 0.0) {return i}
    }
    return 0
}

const drawScope = (painter: CanvasPainter, scope: Float32Array, trig: boolean): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.moveTo(0, h / 2)
    context.lineTo(w, h / 2)
    context.stroke()
    const len = scope.length
    const start = trig ? triggerIndex(scope) : 0
    context.strokeStyle = "hsl(150,65%,60%)"
    context.lineWidth = 1.5
    context.beginPath()
    for (let j = 0; j < len; j++) {
        const x = (j / (len - 1)) * w
        const y = h / 2 - clamp(scope[(start + j) % len] * 0.5, -1.0, 1.0) * (h / 2 - 2)
        if (j === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
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
