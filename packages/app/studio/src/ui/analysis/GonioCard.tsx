import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {CanvasPainter} from "@opendaw/studio-core"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {card, radio} from "./AnalysisControls.tsx"
import {AnalysisSettings} from "./AnalysisSettings.ts"
import {observeProject} from "./AnalysisSource.ts"
import {clearBg} from "./AnalysisCommon.ts"

const drawGonio = (painter: CanvasPainter, pairs: Float32Array, mode: string): void => {
    clearBg(painter)
    const {context, actualWidth: w, actualHeight: h} = painter
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) * 0.5 - 1.0
    context.strokeStyle = "rgba(255,255,255,0.1)"
    context.beginPath()
    context.arc(cx, cy, radius, 0.0, TAU)
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
}

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const GonioCard = ({lifecycle, service}: Construct): HTMLElement => {
    const holder = {pairs: new Float32Array(0)}
    const mode = AnalysisSettings.gonioMode
    const canvas: HTMLCanvasElement = (<canvas/>)
    const painter = lifecycle.own(new CanvasPainter(canvas, painter =>
        drawGonio(painter, holder.pairs, mode.getValue())))
    lifecycle.own(mode.subscribe(painter.requestUpdate))
    observeProject(lifecycle, service, (project, runtime) => {
        runtime.own(project.liveStreamReceiver.subscribeFloats(EngineAddresses.GONIO, values => {
            if (holder.pairs.length !== values.length) {holder.pairs = new Float32Array(values.length)}
            holder.pairs.set(values)
            painter.requestUpdate()
        }))
    })
    return card("Gonio", radio(lifecycle, mode, "L/R", "M/S"), canvas)
}
