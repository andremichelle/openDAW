import {AnimationFrame} from "@opendaw/lib-dom"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@/ui/canvas/painter"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {PERF_BUFFER_SIZE} from "@opendaw/studio-adapters"
import {RenderQuantum} from "@opendaw/lib-dsp"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const WIDTH = 64
const HEIGHT = 32

export const PerformanceStats = ({lifecycle, service}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas width={WIDTH} height={HEIGHT} style={{width: `${WIDTH}px`, height: `${HEIGHT}px`}}/>
    const maxValues = new Float32Array(WIDTH)
    let lastReadIndex = 0
    let currentMax = 0
    let blocksInPixel = 0
    let writePixelIndex = 0
    let budgetMs = (RenderQuantum / service.audioContext.sampleRate) * 1000
    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe(() => {
        runtime.terminate()
        maxValues.fill(0)
        lastReadIndex = 0
        currentMax = 0
        blocksInPixel = 0
        writePixelIndex = 0
        budgetMs = (RenderQuantum / service.audioContext.sampleRate) * 1000
    }))
    const painter = new CanvasPainter(canvas, ({context, actualWidth, actualHeight}) => {
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
        context.fillStyle = Colors.dark.toString()
        context.fillRect(0, 0, actualWidth, actualHeight)
        const barWidth = actualWidth / WIDTH
        for (let pixel = 0; pixel < WIDTH; pixel++) {
            const index = (writePixelIndex + pixel) % WIDTH
            const ratio = Math.min(maxValues[index] / budgetMs, 1.0)
            const barHeight = ratio * actualHeight
            if (ratio < 0.5) {
                context.fillStyle = Colors.green.toString()
            } else if (ratio < 0.8) {
                context.fillStyle = Colors.yellow.toString()
            } else {
                context.fillStyle = Colors.red.toString()
            }
            context.fillRect(pixel * barWidth, actualHeight - barHeight, barWidth, barHeight)
        }
    })
    lifecycle.ownAll(painter, AnimationFrame.add(painter.requestUpdate))
    return canvas
}
