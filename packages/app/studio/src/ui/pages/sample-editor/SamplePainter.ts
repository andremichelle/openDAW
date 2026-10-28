import {int, Option} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Peaks, PeaksPainter} from "@opendaw/lib-fusion"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {SampleRange} from "./SampleDocument"
import {SampleViewport} from "./SampleViewport"

const PeaksThreshold = 16.0
const RulerSteps: ReadonlyArray<number> = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600
]

export namespace SamplePainter {
    export type Waveform = Readonly<{
        audio: AudioData
        peaks: Option<Peaks>
        viewport: SampleViewport
        selection: SampleRange
        playhead: Option<int>
    }>

    export const formatTime = (seconds: number, step: number = 0.001): string => {
        const minutes = Math.floor(seconds / 60)
        const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
        const rest = (seconds - minutes * 60).toFixed(digits).padStart(digits === 0 ? 2 : digits + 3, "0")
        return `${minutes}:${rest}`
    }

    export const waveform = ({context, width, height, devicePixelRatio}: CanvasPainter,
                             {audio, peaks, viewport, selection, playhead}: Waveform): void => {
        const pixelWidth = width * devicePixelRatio
        const pixelHeight = height * devicePixelRatio
        context.clearRect(0, 0, pixelWidth, pixelHeight)
        const {numberOfChannels, numberOfFrames, frames} = audio
        if (numberOfFrames === 0) {return}
        const framesPerPixel = viewport.framesPerPixel / devicePixelRatio
        const start = framesPerPixel >= 1.0 ? Math.round(viewport.start / framesPerPixel) * framesPerPixel : viewport.start
        const xOf = (frame: number) => Math.round((frame - start) / framesPerPixel)
        if (selection.to > selection.from) {
            const x0 = Math.max(0, xOf(selection.from))
            const x1 = Math.min(pixelWidth, xOf(selection.to))
            context.fillStyle = Colors.blue.toString()
            context.globalAlpha = 0.15
            context.fillRect(x0, 0, Math.max(1, x1 - x0), pixelHeight)
            context.globalAlpha = 1.0
        }
        const laneHeight = pixelHeight / numberOfChannels
        const usePeaks = framesPerPixel >= PeaksThreshold
            && peaks.mapOr(({numFrames, numChannels}) =>
                numFrames === numberOfFrames && numChannels === numberOfChannels, false)
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const y0 = laneHeight * channel
            const y1 = y0 + laneHeight
            const center = Math.round((y0 + y1) * 0.5)
            context.fillStyle = Colors.shadow.toString()
            context.fillRect(0, center, pixelWidth, 1)
            if (channel > 0) {context.fillRect(0, Math.round(y0), pixelWidth, 1)}
            context.fillStyle = Colors.blue.toString()
            context.strokeStyle = Colors.blue.toString()
            if (usePeaks) {
                PeaksPainter.renderPixelStrips(context, peaks.unwrap(), channel, {
                    u0: start, u1: start + pixelWidth * framesPerPixel, x0: 0, x1: pixelWidth, y0, y1, v0: 1.0, v1: -1.0
                })
            } else {
                paintFrames(context, frames[channel], start, framesPerPixel, pixelWidth, y0, y1)
            }
        }
        if (selection.to === selection.from) {
            context.fillStyle = Colors.bright.toString()
            context.fillRect(xOf(selection.from), 0, 1, pixelHeight)
        }
        playhead.ifSome(frame => {
            context.fillStyle = Colors.white.toString()
            context.fillRect(xOf(frame), 0, devicePixelRatio, pixelHeight)
        })
    }

    export const ruler = ({context, width, height, devicePixelRatio}: CanvasPainter,
                          viewport: SampleViewport, sampleRate: number): void => {
        const pixelWidth = width * devicePixelRatio
        const pixelHeight = height * devicePixelRatio
        context.clearRect(0, 0, pixelWidth, pixelHeight)
        if (viewport.numberOfFrames === 0) {return}
        const secondsPerPixel = viewport.framesPerPixel / sampleRate
        const step = RulerSteps.find(value => value / secondsPerPixel >= 80) ?? RulerSteps[RulerSteps.length - 1]
        const first = Math.floor(viewport.start / sampleRate / step) * step
        const last = viewport.end / sampleRate
        context.fillStyle = Colors.shadow.toString()
        context.font = `${10 * devicePixelRatio}px sans-serif`
        context.textBaseline = "middle"
        for (let index = 0; first + index * step <= last; index++) {
            const seconds = first + index * step
            const x = Math.round(viewport.xOf(seconds * sampleRate) * devicePixelRatio)
            context.fillRect(x, pixelHeight * 0.5, 1, pixelHeight * 0.5)
            context.fillText(formatTime(seconds, step), x + 3 * devicePixelRatio, pixelHeight * 0.4)
        }
        context.fillRect(0, pixelHeight - 1, pixelWidth, 1)
    }

    export const overview = ({context, width, height, devicePixelRatio}: CanvasPainter,
                             audio: AudioData, peaks: Option<Peaks>, viewport: SampleViewport): void => {
        const pixelWidth = width * devicePixelRatio
        const pixelHeight = height * devicePixelRatio
        context.clearRect(0, 0, pixelWidth, pixelHeight)
        const {numberOfFrames, numberOfChannels} = audio
        if (numberOfFrames === 0) {return}
        context.fillStyle = Colors.dark.toString()
        peaks.ifSome(peaks => {
            if (peaks.numFrames !== numberOfFrames || peaks.numChannels !== numberOfChannels) {return}
            const laneHeight = pixelHeight / numberOfChannels
            for (let channel = 0; channel < numberOfChannels; channel++) {
                PeaksPainter.renderPixelStrips(context, peaks, channel, {
                    u0: 0, u1: numberOfFrames, x0: 0, x1: pixelWidth,
                    y0: laneHeight * channel, y1: laneHeight * (channel + 1), v0: 1.0, v1: -1.0
                })
            }
        })
        const x0 = Math.floor(viewport.start / numberOfFrames * pixelWidth)
        const x1 = Math.ceil(Math.min(viewport.end, numberOfFrames) / numberOfFrames * pixelWidth)
        const radius = 3 * devicePixelRatio
        context.beginPath()
        context.roundRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, pixelHeight - 1, radius)
        context.fillStyle = Colors.blue.toString()
        context.globalAlpha = 0.2
        context.fill()
        context.globalAlpha = 1.0
        context.strokeStyle = Colors.blue.toString()
        context.stroke()
    }

    const paintFrames = (context: CanvasRenderingContext2D, channel: Float32Array, start: number,
                         framesPerPixel: number, pixelWidth: number, y0: number, y1: number): void => {
        const scale = (y1 - y0 - 1) * 0.5
        const center = (y0 + y1) * 0.5
        const yOf = (value: number) => center - Math.max(-1.0, Math.min(1.0, value)) * scale
        if (framesPerPixel < 1.0) {
            const first = Math.max(0, Math.floor(start))
            const last = Math.min(channel.length - 1, Math.ceil(start + pixelWidth * framesPerPixel))
            context.beginPath()
            for (let frame = first; frame <= last; frame++) {
                const x = (frame - start) / framesPerPixel
                if (frame === first) {context.moveTo(x, yOf(channel[frame]))} else {context.lineTo(x, yOf(channel[frame]))}
            }
            context.lineWidth = devicePixelRatio
            context.stroke()
            if (framesPerPixel < 0.125) {
                for (let frame = first; frame <= last; frame++) {
                    const x = (frame - start) / framesPerPixel
                    context.fillRect(x - 2, yOf(channel[frame]) - 2, 4, 4)
                }
            }
            return
        }
        for (let x = 0; x < pixelWidth; x++) {
            const from = Math.max(0, Math.floor(start + x * framesPerPixel))
            const to = Math.min(channel.length, Math.floor(start + (x + 1) * framesPerPixel) + 1)
            if (from >= to) {break}
            let min = channel[from]
            let max = min
            for (let frame = from + 1; frame < to; frame++) {
                const value = channel[frame]
                if (value < min) {min = value} else if (value > max) {max = value}
            }
            const top = yOf(max)
            context.fillRect(x, top, 1, Math.max(1, yOf(min) - top))
        }
    }
}
