import {createElement} from "@opendaw/lib-jsx"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {gainToDb} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {card, owned, radio, toggle} from "./AnalysisControls.tsx"
import {observeProject} from "./AnalysisSource.ts"
import {clearBg, unitLabel, UNIT_COLOR_DIM} from "./AnalysisCommon.ts"

type LevelValues = { peakL: number, peakR: number, rmsL: number, rmsR: number, lufs: number }

const fmtLufs = (value: number): string => value <= -100.0 ? "-∞" : value.toFixed(1)

const LEVEL_FLOOR = -40.0
const LEVEL_CEIL = 14.0
const LEVEL_SCALES: Record<string, { off: number, ticks: ReadonlyArray<number>, unit: string }> = {
    "dBFS": {off: 0.0, ticks: [0, -12, -24, -36], unit: "dBFS"},
    "K-14": {off: 14.0, ticks: [8, 0, -8, -16], unit: "K"},
    "K-20": {off: 20.0, ticks: [6, 0, -10, -20], unit: "K"}
}
const levelNorm = (gain: number, off: number): number =>
    clamp((gainToDb(Math.max(gain, 1e-7)) + off - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR), 0.0, 1.0)

const drawLevel = (painter: CanvasPainter, level: LevelValues, scale: string): void => {
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
        unitLabel(context, index === 0 ? `${tick} ${spec.unit}` : `${tick}`, pad, yAt(tick), "left", "top",
            UNIT_COLOR_DIM))
    unitLabel(context, "peak L R", (peakL + peakR + barWidth) / 2, h - dpr, "center", "bottom", UNIT_COLOR_DIM)
    unitLabel(context, "rms L R", (rmsL + rmsR + barWidth) / 2, h - dpr, "center", "bottom", UNIT_COLOR_DIM)
    unitLabel(context, "LUFS M", lufsX + barWidth / 2, h - dpr, "center", "bottom", UNIT_COLOR_DIM)
}

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const LevelCard = ({lifecycle, service}: Construct): HTMLElement => {
    const level: LevelValues = {peakL: 0.0, peakR: 0.0, rmsL: 0.0, rmsR: 0.0, lufs: 0.0}
    const scale = owned(lifecycle, "dBFS")
    const canvas: HTMLCanvasElement = (<canvas/>)
    const readout: HTMLElement = (<span className="readout"/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => drawLevel(painter, level, scale.getValue())))
    lifecycle.own(scale.subscribe(painter.requestUpdate))
    observeProject(lifecycle, service, (project, runtime) => {
        const {liveStreamReceiver} = project
        runtime.ownAll(
            liveStreamReceiver.subscribeFloats(EngineAddresses.PEAKS, values => {
                level.peakL = values[0]
                level.peakR = values[1]
                level.rmsL = values[2]
                level.rmsR = values[3]
                painter.requestUpdate()
            }),
            liveStreamReceiver.subscribeFloats(EngineAddresses.LOUDNESS, values => {
                const momentary = values[0]
                readout.textContent = `M ${fmtLufs(momentary).padStart(5)}  S ${fmtLufs(values[1]).padStart(5)}  `
                    + `I ${fmtLufs(values[2]).padStart(5)} LUFS  TP ${values[4].toFixed(1).padStart(6)} dBTP`
                level.lufs = clamp((momentary + 40.0) / 40.0, 0.0, 1.0)
                painter.requestUpdate()
            })
        )
    })
    return card("Level", [radio(lifecycle, scale, "dBFS", "K-14", "K-20"),
        toggle(lifecycle, owned(lifecycle, false), "TP"), toggle(lifecycle, owned(lifecycle, false), "Hold")],
        (<div className="lufs">{readout}{canvas}</div>))
}
