import css from "./PerformanceStats.sass?inline"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {StudioPreferences} from "@opendaw/studio-core"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../studio/core/src/ui/canvas/painter"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {PERF_BUFFER_SIZE} from "@opendaw/studio-adapters"
import {RenderQuantum} from "@opendaw/lib-dsp"

const className = Html.adoptStyleSheet(css, "PerformanceStats")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const WIDTH = 64
const HEIGHT = 28

export const PerformanceStats = ({lifecycle, service}: Construct) => {
    const maxValues = new Float32Array(WIDTH)
    let lastReadIndex = 0
    let currentMax = 0
    let blocksInPixel = 0
    let writePixelIndex = 0
    let budgetMs = (RenderQuantum / service.audioContext.sampleRate) * 1000
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(() => {
        maxValues.fill(0)
        lastReadIndex = 0
        currentMax = 0
        blocksInPixel = 0
        writePixelIndex = 0
        budgetMs = (RenderQuantum / service.audioContext.sampleRate) * 1000
    }))
    return (
        <div className={className}
             onInit={element => {
                 const animationLifeSpan = lifecycle.own(new Terminator())
                 lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                     element.classList.toggle("hidden", !show)
                     animationLifeSpan.terminate()
                     if (show) {
                         const canvas = element.querySelector("canvas")!
                         const painter = animationLifeSpan.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight}) => {
                             const engine = service.engine
                             const perfBuffer = engine.perfBuffer
                             const perfIndex = engine.perfIndex
                             let readIndex = lastReadIndex
                             while (readIndex !== perfIndex) {
                                 const ms = perfBuffer[readIndex]
                                 if (ms > currentMax) {currentMax = ms}
                                 blocksInPixel++
                                 if (blocksInPixel >= 6) {
                                     maxValues[writePixelIndex] = currentMax
                                     writePixelIndex = (writePixelIndex + 1) % WIDTH
                                     currentMax = 0
                                     blocksInPixel = 0
                                 }
                                 readIndex = (readIndex + 1) % PERF_BUFFER_SIZE
                             }
                             lastReadIndex = readIndex
                             context.clearRect(0, 0, actualWidth, actualHeight)
                             const barWidth = actualWidth / WIDTH
                             for (let pixel = 0; pixel < WIDTH; pixel++) {
                                 const index = (writePixelIndex + pixel) % WIDTH
                                 const ratio = Math.min(maxValues[index] / budgetMs, 1.0)
                                 const barHeight = ratio * actualHeight
                                 if (ratio < 0.75) {
                                     context.fillStyle = Colors.green.toString()
                                 } else if (ratio < 1.0) {
                                     context.fillStyle = Colors.orange.toString()
                                 } else {
                                     context.fillStyle = Colors.red.toString()
                                 }
                                 context.fillRect(pixel * barWidth, actualHeight - barHeight, barWidth, barHeight)
                             }
                         }))
                         animationLifeSpan.own(AnimationFrame.add(painter.requestUpdate))
                     }
                 }, "debug", "show-cpu-stats"))
             }}>
            <div className="label">CPU</div>
            <canvas style={{width: `${WIDTH}px`, height: `${HEIGHT}px`}}/>
            <div className="end"/>
        </div>
    )
}
