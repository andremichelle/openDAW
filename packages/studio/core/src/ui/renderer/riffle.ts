import {dbToGain} from "@moises-ai/lib-dsp"
import {Peaks} from "@moises-ai/lib-fusion"
import {AudioRenderer} from "./audio"

export const RiffleStrategy: AudioRenderer.Strategy = {
    render(context, segments, peaks, {top, bottom}, gain): void {
        if (segments.length === 0) {return}
        const dpr = devicePixelRatio
        const actualTop = top * dpr
        const actualBottom = bottom * dpr
        const height = actualBottom - actualTop
        const numberOfChannels = peaks.numChannels
        const peaksHeight = Math.floor(height / numberOfChannels)
        const gainScale = dbToGain(-gain)
        const blockWidth = 3 * dpr
        // noinspection PointlessArithmeticExpressionJS
        const gap = dpr * 1
        const pixelsPerBlock = blockWidth + gap
        let globalX0 = Infinity
        let globalX1 = -Infinity
        for (const {x0, x1} of segments) {
            globalX0 = Math.min(globalX0, Math.floor(x0))
            globalX1 = Math.max(globalX1, Math.floor(x1))
        }
        if (globalX0 >= globalX1) {return}
        const seg0 = segments[0]
        const pxPerUnit = (seg0.x1 - seg0.x0) / (seg0.u1 - seg0.u0)
        const anchorX = seg0.x0 - seg0.u0 * pxPerUnit
        const gridPhase = ((globalX0 - anchorX) % pixelsPerBlock + pixelsPerBlock) % pixelsPerBlock
        const firstBlockX = globalX0 - gridPhase
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const data = peaks.data[channel]
            const channelY0 = actualTop + channel * peaksHeight
            const channelY1 = actualTop + (channel + 1) * peaksHeight
            const centerY = (channelY0 + channelY1) / 2
            const yScale = (channelY1 - channelY0 - 1.0) / (gainScale * 2)
            for (let bx = firstBlockX; bx < globalX1; bx += pixelsPerBlock) {
                const bxEnd = bx + pixelsPerBlock
                let blockMin = 0.0
                let blockMax = 0.0
                let blockAlpha = 0.0
                let hasData = false
                for (const seg of segments) {
                    const segX0 = Math.floor(seg.x0)
                    const segX1 = Math.floor(seg.x1)
                    if (segX0 >= bxEnd || segX1 <= bx) {continue}
                    const pixelSpan = seg.x1 - seg.x0
                    if (pixelSpan <= 0) {continue}
                    const uPerPx = (seg.u1 - seg.u0) / pixelSpan
                    const stage = peaks.nearest(uPerPx)
                    if (stage === null) {continue}
                    const uPerPeak = stage.unitsEachPeak()
                    const peaksPerPx = uPerPx / uPerPeak
                    const overflow = seg.x0 - segX0
                    const fromAtX0 = (seg.u0 - overflow * uPerPx) / uPerPx * peaksPerPx
                    const overlapStart = Math.max(bx, segX0)
                    const overlapEnd = Math.min(bxEnd, segX1)
                    const fromPeak = fromAtX0 + (overlapStart - segX0) * peaksPerPx
                    const toPeak = fromAtX0 + (overlapEnd - segX0) * peaksPerPx
                    const idxFrom = Math.max(0, Math.floor(fromPeak))
                    const idxTo = Math.floor(toPeak)
                    for (let idx = idxFrom; idx < idxTo; idx++) {
                        const bits = data[stage.dataOffset + idx]
                        blockMin = Math.min(Peaks.unpack(bits, 0), blockMin)
                        blockMax = Math.max(Peaks.unpack(bits, 1), blockMax)
                    }
                    if (idxFrom < idxTo) {hasData = true}
                    blockAlpha = Math.max(blockAlpha, seg.outside ? 0.25 : 1.0)
                }
                if (!hasData) {continue}
                context.globalAlpha = blockAlpha
                const x = Math.max(bx, globalX0)
                const w = Math.min(blockWidth, Math.min(bxEnd, globalX1) - x)
                if (w <= 0) {continue}
                const yMin = channelY0 + Math.floor((blockMin + gainScale) * yScale)
                const yMax = channelY0 + Math.floor((blockMax + gainScale) * yScale)
                const ry0 = Math.max(channelY0, Math.min(yMin, yMax))
                const ry1 = Math.min(channelY1, Math.max(yMin, yMax))
                const finalY1 = ry0 === ry1 ? ry0 + 1 : ry1
                const maxDist = Math.max(centerY - ry0, finalY1 - centerY)
                const symY0 = centerY - maxDist
                const symY1 = centerY + maxDist
                const h = symY1 - symY0
                const r = Math.min(dpr, w / 2, h / 2)
                context.beginPath()
                context.roundRect(x, symY0, w, h, r)
                context.fill()
            }
        }
        context.globalAlpha = 1.0
    }
}