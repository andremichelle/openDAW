import {isDefined} from "@opendaw/lib-std"
import {NamModel} from "@andremichelle/nam-wasm"

export interface WeightStats {
    count: number
    min: number
    max: number
    mean: number
    stdDev: number
    zeros: number
    positive: number
    negative: number
}

export const computeStats = (weights: number[]): WeightStats => {
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

export const drawHistogram = (
    canvas: HTMLCanvasElement,
    weights: number[],
    bins: number = 100
): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const width = canvas.width
    const height = canvas.height
    const padding = 40

    // Compute histogram
    const stats = computeStats(weights)
    const range = stats.max - stats.min
    const binWidth = range / bins
    const histogram = new Array(bins).fill(0)

    for (const weight of weights) {
        const binIndex = Math.min(Math.floor((weight - stats.min) / binWidth), bins - 1)
        histogram[binIndex]++
    }

    const maxCount = Math.max(...histogram)

    // Clear
    ctx.fillStyle = "#1a1a2e"
    ctx.fillRect(0, 0, width, height)

    // Draw bars
    const barWidth = (width - padding * 2) / bins
    const chartHeight = height - padding * 2

    ctx.fillStyle = "#4a9eff"
    for (let i = 0; i < bins; i++) {
        const barHeight = (histogram[i] / maxCount) * chartHeight
        const x = padding + i * barWidth
        const y = height - padding - barHeight
        ctx.fillRect(x, y, barWidth - 1, barHeight)
    }

    // Draw axes
    ctx.strokeStyle = "#666"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padding, padding)
    ctx.lineTo(padding, height - padding)
    ctx.lineTo(width - padding, height - padding)
    ctx.stroke()

    // Labels
    ctx.fillStyle = "#888"
    ctx.font = "12px monospace"
    ctx.textAlign = "center"
    ctx.fillText(stats.min.toFixed(3), padding, height - 10)
    ctx.fillText(stats.max.toFixed(3), width - padding, height - 10)
    ctx.fillText("0", padding + (width - padding * 2) * (-stats.min / range), height - 10)

    ctx.textAlign = "left"
    ctx.fillText(`max: ${maxCount}`, padding + 5, padding + 15)
}

export const drawHeatmap = (
    canvas: HTMLCanvasElement,
    weights: number[],
    cols: number = 256
): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const rows = Math.ceil(weights.length / cols)
    canvas.width = cols
    canvas.height = rows

    const imageData = ctx.createImageData(cols, rows)
    const data = imageData.data

    const stats = computeStats(weights)
    const absMax = Math.max(Math.abs(stats.min), Math.abs(stats.max))

    for (let i = 0; i < weights.length; i++) {
        const normalized = weights[i] / absMax // -1 to 1
        const pixelIndex = i * 4

        if (normalized >= 0) {
            // Positive: black to red
            data[pixelIndex] = Math.floor(normalized * 255)     // R
            data[pixelIndex + 1] = 0                             // G
            data[pixelIndex + 2] = 0                             // B
        } else {
            // Negative: black to blue
            data[pixelIndex] = 0                                 // R
            data[pixelIndex + 1] = 0                             // G
            data[pixelIndex + 2] = Math.floor(-normalized * 255) // B
        }
        data[pixelIndex + 3] = 255 // A
    }

    // Fill remaining pixels
    for (let i = weights.length; i < cols * rows; i++) {
        const pixelIndex = i * 4
        data[pixelIndex] = 30
        data[pixelIndex + 1] = 30
        data[pixelIndex + 2] = 46
        data[pixelIndex + 3] = 255
    }

    ctx.putImageData(imageData, 0, 0)
}

export const drawLayerDiagram = (canvas: HTMLCanvasElement, model: NamModel): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const width = canvas.width
    const height = canvas.height

    ctx.fillStyle = "#1a1a2e"
    ctx.fillRect(0, 0, width, height)

    const layers = model.config.layers
    if (layers.length === 0) return

    const layerWidth = 60
    const maxChannels = Math.max(...layers.map(layer => layer.channels))
    const spacing = (width - 100) / (layers.length + 1)

    ctx.font = "10px monospace"
    ctx.textAlign = "center"

    // Input
    ctx.fillStyle = "#4a9eff"
    ctx.fillRect(30, height / 2 - 20, 20, 40)
    ctx.fillStyle = "#888"
    ctx.fillText("In", 40, height / 2 + 50)

    // Layers
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]
        const x = 80 + spacing * i
        const layerHeight = (layer.channels / maxChannels) * (height - 100)
        const y = (height - layerHeight) / 2

        // Layer box
        ctx.fillStyle = layer.gated ? "#ff6b6b" : "#4ecdc4"
        ctx.fillRect(x, y, layerWidth, layerHeight)

        // Connection line
        if (i > 0) {
            ctx.strokeStyle = "#444"
            ctx.lineWidth = 1
            ctx.beginPath()
            const prevX = 80 + spacing * (i - 1) + layerWidth
            ctx.moveTo(prevX, height / 2)
            ctx.lineTo(x, height / 2)
            ctx.stroke()
        } else {
            ctx.strokeStyle = "#444"
            ctx.beginPath()
            ctx.moveTo(50, height / 2)
            ctx.lineTo(x, height / 2)
            ctx.stroke()
        }

        // Label
        ctx.fillStyle = "#888"
        ctx.fillText(`${layer.channels}ch`, x + layerWidth / 2, y + layerHeight + 15)
        ctx.fillText(`k${layer.kernel_size}`, x + layerWidth / 2, y - 5)
    }

    // Output
    const lastX = 80 + spacing * (layers.length - 1) + layerWidth
    ctx.strokeStyle = "#444"
    ctx.beginPath()
    ctx.moveTo(lastX, height / 2)
    ctx.lineTo(width - 30, height / 2)
    ctx.stroke()

    ctx.fillStyle = "#4a9eff"
    ctx.fillRect(width - 50, height / 2 - 20, 20, 40)
    ctx.fillStyle = "#888"
    ctx.fillText("Out", width - 40, height / 2 + 50)

    // Title
    ctx.fillStyle = "#fff"
    ctx.font = "14px monospace"
    ctx.textAlign = "left"
    ctx.fillText(`${model.architecture} - ${layers.length} layers`, 10, 20)
}

export const drawWeightDistributionByLayer = (
    canvas: HTMLCanvasElement,
    model: NamModel
): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const width = canvas.width
    const height = canvas.height

    ctx.fillStyle = "#1a1a2e"
    ctx.fillRect(0, 0, width, height)

    // Simple visualization: show weight magnitude distribution
    const weights = model.weights
    const segmentSize = Math.floor(weights.length / 20)
    const segments: number[] = []

    for (let i = 0; i < 20; i++) {
        const start = i * segmentSize
        const end = Math.min(start + segmentSize, weights.length)
        let sum = 0
        for (let j = start; j < end; j++) {
            sum += Math.abs(weights[j])
        }
        segments.push(sum / (end - start))
    }

    const maxAvg = Math.max(...segments)
    const barWidth = (width - 40) / segments.length

    ctx.fillStyle = "#9b59b6"
    for (let i = 0; i < segments.length; i++) {
        const barHeight = (segments[i] / maxAvg) * (height - 60)
        ctx.fillRect(20 + i * barWidth, height - 30 - barHeight, barWidth - 2, barHeight)
    }

    ctx.fillStyle = "#888"
    ctx.font = "12px monospace"
    ctx.textAlign = "left"
    ctx.fillText("Average |weight| by segment", 10, 20)
    ctx.fillText("Start", 20, height - 10)
    ctx.textAlign = "right"
    ctx.fillText("End", width - 20, height - 10)
}
