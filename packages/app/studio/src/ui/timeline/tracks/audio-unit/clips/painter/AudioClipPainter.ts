import {int, Iterables, Nullable, Procedure, TAU} from "@opendaw/lib-std"
import {AudioClipBoxAdapter} from "@opendaw/studio-adapters"
import {Peaks} from "@opendaw/lib-fusion"
import {dbToGain} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"

export const createAudioClipPainter = (adapter: AudioClipBoxAdapter): Procedure<CanvasPainter> => painter => {
    const {context, actualHeight: size} = painter
    const radius = size >> 1
    const {file, gain, duration, optWarpMarkers, isPlayModeNoStretch, waveformOffset} = adapter
    if (file.peaks.isEmpty()) {return}
    const numRays = 256
    const peaks = file.peaks.unwrap()
    const numFrames = peaks.numFrames
    const durationInSeconds = file.endInSeconds - file.startInSeconds
    const scale = dbToGain(gain.getValue())
    const minRadius = 4 * devicePixelRatio
    const maxRadius = radius - 4 * devicePixelRatio
    const centerRadius = (minRadius + maxRadius) * 0.5
    context.save()
    context.translate(radius, radius)
    context.strokeStyle = `hsl(${adapter.hue}, 50%, 80%)`
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
    if (optWarpMarkers.nonEmpty() && !isPlayModeNoStretch) {
        const warpMarkers = optWarpMarkers.unwrap()
        const data: Int32Array = peaks.data[0]
        for (const [w0, w1] of Iterables.pairWise(warpMarkers.iterateFrom(0))) {
            if (w1 === null) {break}
            const segmentStartPosition = Math.max(0, w0.position)
            const segmentEndPosition = Math.min(duration, w1.position)
            if (segmentStartPosition >= segmentEndPosition) {continue}
            const rayStart = Math.floor((segmentStartPosition / duration) * numRays)
            const rayEnd = Math.ceil((segmentEndPosition / duration) * numRays)
            const numSegmentRays = rayEnd - rayStart
            if (numSegmentRays <= 0) {continue}
            const segmentPositionRange = w1.position - w0.position
            const segmentSecondsRange = w1.seconds - w0.seconds
            const segmentFrames = Math.abs(segmentSecondsRange / durationInSeconds * numFrames)
            const framesPerRay = segmentFrames / numSegmentRays
            const stage: Nullable<Peaks.Stage> = peaks.nearest(framesPerRay)
            if (stage === null) {continue}
            const unitsEachPeak = stage.unitsEachPeak()
            const maxIndex = data.length - 1 - stage.dataOffset
            for (let ray = rayStart; ray < rayEnd; ray++) {
                const clipPosition = (ray / numRays) * duration
                const t = (clipPosition - w0.position) / segmentPositionRange
                const seconds = w0.seconds + t * segmentSecondsRange + waveformOffset.getValue()
                const frameIndex = (seconds / durationInSeconds) * numFrames
                const index = Math.min(Math.floor(frameIndex / unitsEachPeak), maxIndex)
                if (index < 0) {continue}
                const bits = data[stage.dataOffset + index]
                drawRay(ray, Peaks.unpack(bits, 0), Peaks.unpack(bits, 1))
            }
        }
    } else {
        const unitsEachPixel = numFrames / numRays
        const stage: Nullable<Peaks.Stage> = peaks.nearest(unitsEachPixel)
        if (stage === null) {
            context.restore()
            return
        }
        const unitsEachPeak = stage.unitsEachPeak()
        const peaksEachRay = unitsEachPixel / unitsEachPeak
        const data: Int32Array = peaks.data[0]
        const sampleRate = numFrames / durationInSeconds
        const offsetFrames = waveformOffset.getValue() * sampleRate
        let from = offsetFrames / unitsEachPeak
        let indexFrom: int = Math.floor(from)
        let min: number = 0.0
        let max: number = 0.0
        for (let i = 0; i < numRays; i++) {
            const to = from + peaksEachRay
            const indexTo = Math.floor(to)
            let swap = false
            while (indexFrom < indexTo) {
                if (indexFrom >= 0) {
                    const bits = data[stage.dataOffset + indexFrom]
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
    }
    context.stroke()
    context.restore()
}