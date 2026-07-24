import {createElement} from "@opendaw/lib-jsx"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {AudioAnalyser} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {card, owned, toggle} from "./AnalysisControls.tsx"
import {observeProject} from "./AnalysisSource.ts"
import {clearBg, unitLabel} from "./AnalysisCommon.ts"

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

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const ScopeCard = ({lifecycle, service}: Construct): HTMLElement => {
    const waveform = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const trig = owned(lifecycle, false)
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => drawScope(painter, waveform, trig.getValue())))
    lifecycle.own(trig.subscribe(painter.requestUpdate))
    observeProject(lifecycle, service, (project, runtime) => {
        runtime.own(project.liveStreamReceiver.subscribeFloats(EngineAddresses.WAVEFORM, values => {
            waveform.set(values)
            painter.requestUpdate()
        }))
    })
    return card("Scope", toggle(lifecycle, trig, "Trig"), canvas)
}
