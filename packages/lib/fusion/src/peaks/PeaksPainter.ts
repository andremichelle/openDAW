import {int} from "@moises-ai/lib-std"
import {Peaks} from "./Peaks"

export namespace PeaksPainter {
    export interface Layout {
        x0: number, // screen left (0)
        x1: number, // screen right (width)
        u0: number, // sample start (0)
        u1: number // sample end (numFrames of audio-data)
        y0: number, // screen top (0)
        y1: number, // screen bottom (height)
        v0: number, // value min (-1)
        v1: number // value max (+1)
    }

    export const renderBlocks = (path: CanvasRenderingContext2D,
                                 peaks: Peaks,
                                 channelIndex: int,
                                 {u0, u1, v0, v1, x0, x1, y0, y1}: Layout): void => {
        const unitsEachPixel = (u1 - u0) / (x1 - x0)
        const stage = peaks.nearest(unitsEachPixel)
        if (stage === null) {return}
        const scale = (y1 - y0 - 1.0) / (v1 - v0)
        const unitsEachPeak = stage.unitsEachPeak()
        const pixelOverFlow = x0 - Math.floor(x0)
        const peaksEachPixel = unitsEachPixel / unitsEachPeak
        let from = (u0 - pixelOverFlow * unitsEachPixel) / unitsEachPixel * peaksEachPixel
        let indexFrom: int = Math.floor(from)
        let min: number = 0.0
        let max: number = 0.0
        const data: Int32Array = peaks.data[channelIndex]
        for (let x = Math.floor(x0); x < Math.floor(x1); x++) {
            const to = from + peaksEachPixel
            const indexTo = Math.floor(to)
            let swap = false
            while (indexFrom < indexTo) {
                const bits = data[stage.dataOffset + indexFrom++]
                min = Math.min(Peaks.unpack(bits, 0), min)
                max = Math.max(Peaks.unpack(bits, 1), max)
                swap = true
            }
            const yMin = y0 + Math.floor((min - v0) * scale)
            const yMax = y0 + Math.floor((max - v0) * scale)
            const ry0 = Math.max(y0, Math.min(yMin, yMax))
            const ry1 = Math.min(y1, Math.max(yMin, yMax))
            path.fillRect(x, ry0, 1, ry1 === ry0 ? 1 : ry1 - ry0)
            if (swap) {
                const tmp = max
                max = min
                min = tmp
            }
            from = to
            indexFrom = indexTo
        }
    }
}