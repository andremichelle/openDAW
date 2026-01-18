import {isDefined} from "@opendaw/lib-std"
import {NamModel} from "@andremichelle/nam-wasm"

// Colors matching DisplayPaint style
const positiveColor = (opacity: number) => `hsla(200, 83%, 60%, ${opacity})` // cyan-blue
const negativeColor = (opacity: number) => `hsla(340, 83%, 60%, ${opacity})` // magenta-pink

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

// Precomputed heatmap data for efficient animation
export interface HeatmapData {
    positions: Float32Array  // x, y pairs
    intensities: Float32Array
    signs: Int8Array  // 1 for positive, -1 for negative
    size: number
}

// Precompute positions and intensities once when model loads
export const createHeatmapData = (weights: number[]): HeatmapData => {
    const size = 300
    const centerX = size / 2
    const centerY = size / 2
    const maxRadius = size / 2 - 10

    // Percentile-based scaling
    const sorted = [...weights].map(Math.abs).sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)]

    const positions = new Float32Array(weights.length * 2)
    const intensities = new Float32Array(weights.length)
    const signs = new Int8Array(weights.length)

    for (let i = 0; i < weights.length; i++) {
        // Fermat spiral for even visual distribution
        const angle = i * 2.4 // Golden angle approximation
        const radius = Math.sqrt(i / weights.length) * maxRadius

        positions[i * 2] = centerX + Math.cos(angle) * radius
        positions[i * 2 + 1] = centerY + Math.sin(angle) * radius
        intensities[i] = Math.min(Math.abs(weights[i]) / p95, 1)
        signs[i] = weights[i] >= 0 ? 1 : -1
    }

    return {positions, intensities, signs, size}
}

// Fast draw using precomputed data
export const drawHeatmapAnimated = (
    canvas: HTMLCanvasElement,
    data: HeatmapData,
    audioLevel: number = 0
): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const {positions, intensities, signs, size} = data

    // Set canvas size only if needed
    if (canvas.width !== size) {
        canvas.width = size
        canvas.height = size
    }

    // Clear
    ctx.fillStyle = "#0a0a10"
    ctx.fillRect(0, 0, size, size)

    // Audio-reactive glow
    const glowBoost = 1 + audioLevel * 0.8

    // Draw in batches by color to reduce state changes
    const count = intensities.length

    // Draw positive weights (cyan)
    ctx.fillStyle = positiveColor(0.5 * glowBoost)
    for (let i = 0; i < count; i++) {
        if (signs[i] > 0) {
            const alpha = Math.min(intensities[i] * 0.8 + 0.1, 1) * glowBoost
            if (alpha > 0.15) {
                ctx.globalAlpha = alpha
                ctx.fillRect(positions[i * 2] - 0.5, positions[i * 2 + 1] - 0.5, 1.5, 1.5)
            }
        }
    }

    // Draw negative weights (magenta)
    ctx.fillStyle = negativeColor(0.5 * glowBoost)
    for (let i = 0; i < count; i++) {
        if (signs[i] < 0) {
            const alpha = Math.min(intensities[i] * 0.8 + 0.1, 1) * glowBoost
            if (alpha > 0.15) {
                ctx.globalAlpha = alpha
                ctx.fillRect(positions[i * 2] - 0.5, positions[i * 2 + 1] - 0.5, 1.5, 1.5)
            }
        }
    }

    ctx.globalAlpha = 1
}

// Static version for display
export const drawHeatmap = (
    canvas: HTMLCanvasElement,
    weights: number[]
): void => {
    const data = createHeatmapData(weights)
    drawHeatmapAnimated(canvas, data, 0)
}

// Frequency spectrum comparison (input vs output)
export const drawSpectrumComparison = (
    canvas: HTMLCanvasElement,
    inputData: Float32Array,
    outputData: Float32Array,
    fftSize: number
): void => {
    const ctx = canvas.getContext("2d")
    if (!isDefined(ctx)) return

    const width = canvas.width
    const height = canvas.height
    const binCount = fftSize / 2

    // Clear
    ctx.fillStyle = "#0a0a10"
    ctx.fillRect(0, 0, width, height)

    // Draw center line
    const centerY = height / 2
    ctx.strokeStyle = "#333"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(width, centerY)
    ctx.stroke()

    // getFloatFrequencyData returns dB values (typically -100 to 0)
    const maxDb = 0
    const minDb = -100
    const dbRange = maxDb - minDb

    const getY = (dbValue: number, isInput: boolean): number => {
        // dbValue is already in dB from analyser
        const normalized = (dbValue - minDb) / dbRange
        const barHeight = Math.max(0, Math.min(1, normalized)) * (height / 2 - 10)
        return isInput ? centerY - barHeight : centerY + barHeight
    }

    // Draw input spectrum (top, cyan) - use logarithmic frequency scale
    ctx.beginPath()
    ctx.strokeStyle = positiveColor(0.9)
    ctx.lineWidth = 2
    for (let i = 1; i < binCount; i++) {
        // Logarithmic x scale for frequency
        const logX = Math.log(i) / Math.log(binCount)
        const x = logX * width
        const y = getY(inputData[i], true)
        if (i === 1) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Draw output spectrum (bottom, magenta)
    ctx.beginPath()
    ctx.strokeStyle = negativeColor(0.9)
    ctx.lineWidth = 2
    for (let i = 1; i < binCount; i++) {
        const logX = Math.log(i) / Math.log(binCount)
        const x = logX * width
        const y = getY(outputData[i], false)
        if (i === 1) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Labels
    ctx.fillStyle = positiveColor(1)
    ctx.font = "11px monospace"
    ctx.textAlign = "left"
    ctx.fillText("Input", 5, 15)
    ctx.fillStyle = negativeColor(1)
    ctx.fillText("Output", 5, height - 5)
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
