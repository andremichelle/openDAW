import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {isNull, Lifecycle} from "@opendaw/lib-std"

type Construct = {
    lifecycle: Lifecycle
    weights: number[]
}

export const MagnitudeCanvas = ({lifecycle, weights}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    lifecycle.own(Html.watchResize(canvas, () => {
        if (!canvas.isConnected) {return}
        const width = canvas.clientWidth
        if (width === 0) {return}
        const dpr = window.devicePixelRatio
        const height = 32
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.height = `${height}px`
        const ctx = canvas.getContext("2d")
        if (isNull(ctx)) {return}
        ctx.scale(dpr, dpr)
        const segmentCount = 40
        const segmentSize = Math.floor(weights.length / segmentCount)
        const segments: number[] = []
        for (let i = 0; i < segmentCount; i++) {
            const start = i * segmentSize
            const end = Math.min(start + segmentSize, weights.length)
            let sum = 0
            for (let j = start; j < end; j++) {
                sum += Math.abs(weights[j])
            }
            segments.push(sum / (end - start))
        }
        const maxAvg = Math.max(...segments)
        const barW = width / segmentCount
        const purple = Colors.purple.toString()
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = purple
        for (let index = 0; index < segmentCount; index++) {
            const barHeight = (segments[index] / maxAvg) * height
            const x = index * barW
            const y = height - barHeight
            ctx.fillRect(x, y, barW - 1, barHeight)
        }
    }))
    return canvas
}
