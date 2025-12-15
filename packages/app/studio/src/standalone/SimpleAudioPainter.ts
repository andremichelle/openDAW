import {CanvasPainter} from "@/ui/canvas/painter.ts"
import {int, Nullable, Procedure, TAU} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {dbToGain} from "@opendaw/lib-dsp"

export interface SimpleAudioData {
    peaks: Peaks
    durationSeconds: number
    gain: number
    hue: number
}

export const createSimpleAudioPainter = (data: SimpleAudioData): Procedure<CanvasPainter> => painter => {
    const {context, actualHeight: size} = painter
    const radius = size >> 1
    const {peaks, gain, hue} = data

    if (peaks.numFrames === 0) {return}

    const numRays = 256
    const numFrames = peaks.numFrames
    const scale = dbToGain(gain)
    const minRadius = 4 * devicePixelRatio
    const maxRadius = radius - 4 * devicePixelRatio
    const centerRadius = (minRadius + maxRadius) * 0.5

    context.save()
    context.translate(radius, radius)
    context.strokeStyle = `hsl(${hue}, 50%, 80%)`
    context.beginPath()

    const drawRay = (rayIndex: number, min: number, max: number): void => {
        const angle = rayIndex / numRays * TAU
        const sin = Math.sin(angle)
        const cos = -Math.cos(angle)
        const minR = centerRadius - min * (minRadius - centerRadius) * scale
        const maxR = centerRadius + max * (maxRadius - centerRadius) * scale
        context.moveTo(sin * minR, cos * minR)
        context.lineTo(sin * maxR, cos * maxR)
    }

    const unitsEachPixel = numFrames / numRays
    const stage: Nullable<Peaks.Stage> = peaks.nearest(unitsEachPixel)

    if (stage === null) {
        context.restore()
        return
    }

    const unitsEachPeak = stage.unitsEachPeak()
    const peaksEachRay = unitsEachPixel / unitsEachPeak
    const peakData: Int32Array = peaks.data[0]

    let from = 0
    let indexFrom: int = Math.floor(from)
    let min: number = 0.0
    let max: number = 0.0

    for (let i = 0; i < numRays; i++) {
        const to = from + peaksEachRay
        const indexTo = Math.floor(to)
        let swap = false
        while (indexFrom < indexTo) {
            if (indexFrom >= 0 && indexFrom < peakData.length - stage.dataOffset) {
                const bits = peakData[stage.dataOffset + indexFrom]
                min = Math.min(Peaks.unpack(bits, 0), min)
                max = Math.max(Peaks.unpack(bits, 1), max)
            }
            indexFrom++
            swap = true
        }
        drawRay(i, min, max)
        if (swap) {
            const tmp = max
            max = min
            min = tmp
        }
        from = to
        indexFrom = indexTo
    }

    context.stroke()
    context.restore()
}
