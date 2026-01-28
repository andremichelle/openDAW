import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"
import {isNull, Lifecycle} from "@moises-ai/lib-std"

interface WeightStats {
    count: number
    min: number
    max: number
    mean: number
    stdDev: number
    zeros: number
    positive: number
    negative: number
}

const computeStats = (weights: number[]): WeightStats => {
    const count = weights.length
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let zeros = 0
    let positive = 0
    let negative = 0
    for (const weight of weights) {
        if (weight < min) min = weight
        if (weight > max) max = weight
        sum += weight
        if (weight === 0) zeros++
        else if (weight > 0) positive++
        else negative++
    }
    const mean = sum / count
    let varianceSum = 0
    for (const weight of weights) {
        varianceSum += (weight - mean) ** 2
    }
    const stdDev = Math.sqrt(varianceSum / count)
    return {count, min, max, mean, stdDev, zeros, positive, negative}
}

type Construct = {
    lifecycle: Lifecycle
    weights: number[]
}

export const HistogramCanvas = ({lifecycle, weights}: Construct) => {
    const canvas: HTMLCanvasElement = <canvas/>
    const stats = computeStats(weights)
    lifecycle.own(Html.watchResize(canvas, () => {
        if (!canvas.isConnected) return
        const width = canvas.clientWidth
        if (width === 0) return
        const dpr = window.devicePixelRatio
        const height = 60
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.height = `${height}px`
        const ctx = canvas.getContext("2d")
        if (isNull(ctx)) return
        ctx.scale(dpr, dpr)
        const bins = 80
        const range = stats.max - stats.min
        const binWidth = range / bins
        const histogram = new Array(bins).fill(0)
        for (const weight of weights) {
            const binIndex = Math.min(Math.floor((weight - stats.min) / binWidth), bins - 1)
            histogram[binIndex]++
        }
        const maxCount = Math.max(...histogram)
        const barW = width / bins
        const blue = Colors.blue.toString()
        const shadow = Colors.shadow.toString()
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = blue
        for (let index = 0; index < bins; index++) {
            const barHeight = (histogram[index] / maxCount) * height
            const x = index * barW
            const y = height - barHeight
            ctx.fillRect(x, y, barW - 1, barHeight)
        }
        const zeroX = width * (-stats.min / range)
        ctx.strokeStyle = shadow
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(zeroX, 0)
        ctx.lineTo(zeroX, height)
        ctx.stroke()
        ctx.setLineDash([])
    }))
    return canvas
}

export {computeStats, type WeightStats}
