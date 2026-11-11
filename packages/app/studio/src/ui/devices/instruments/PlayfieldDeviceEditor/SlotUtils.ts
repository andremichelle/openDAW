import {int} from "@opendaw/lib-std"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {CanvasPainter} from "@opendaw/studio-core"

import {NanoDeviceBoxAdapter, PlayfieldSampleBoxAdapter} from "@opendaw/studio-adapters"

export namespace SlotUtils {
    export const color = (semitone: int) => `hsl(${semitone / 13 * 360}, 100%, 70%)`

    export const waveform = ({context, width, height}: CanvasPainter,
                             sample: NanoDeviceBoxAdapter | PlayfieldSampleBoxAdapter,
                             semitone: int, forceBounds: boolean = false): void => sample.file().match({
        none: () => context.clearRect(0, 0, width, height),
        some: file => {
            context.clearRect(0, 0, width, height)
            file.getOrCreateLoader().peaks.ifSome(peaks => {
                const {numFrames, numChannels} = peaks
                const {sampleStart, sampleEnd} = sample.namedParameter
                const wd = (width - 1) * devicePixelRatio
                const s0 = Math.min(sampleStart.getValue(), sampleEnd.getValue())
                const s1 = Math.max(sampleStart.getValue(), sampleEnd.getValue())
                const u0 = s0 * numFrames
                const u1 = s1 * numFrames
                const x0 = s0 * wd
                const x1 = s1 * wd
                context.fillStyle = color(semitone)
                const rowHeight = height * devicePixelRatio / numChannels
                for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                    layout.u0 = u0
                    layout.u1 = u1
                    layout.x0 = x0
                    layout.x1 = x1
                    layout.y0 = rowHeight * channelIndex
                    layout.y1 = rowHeight * (channelIndex + 1)
                    PeaksPainter.renderPixelStrips(context, peaks, channelIndex, layout)
                }
                if (x0 > 0.0 || forceBounds) {
                    context.fillRect(Math.round(x0), 0, 1, height * devicePixelRatio)
                }
                if (x1 < wd || forceBounds) {
                    context.fillRect(Math.round(x1), 0, 1, height * devicePixelRatio)
                }
                if (u0 > 0.0) {
                    context.globalAlpha = 0.25
                    for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                        layout.u0 = 0.0
                        layout.u1 = u0
                        layout.x0 = 0.0
                        layout.x1 = x0
                        layout.y0 = rowHeight * channelIndex
                        layout.y1 = rowHeight * (channelIndex + 1)
                        PeaksPainter.renderPixelStrips(context, peaks, channelIndex, layout)
                    }
                }
                if (u1 < numFrames) {
                    context.globalAlpha = 0.25
                    for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                        layout.u0 = u1
                        layout.u1 = numFrames
                        layout.x0 = x1
                        layout.x1 = wd
                        layout.y0 = rowHeight * channelIndex
                        layout.y1 = rowHeight * (channelIndex + 1)
                        PeaksPainter.renderPixelStrips(context, peaks, channelIndex, layout)
                    }
                }
                context.globalAlpha = 1.0
            })
        }
    })

    export const SilenceLevel = 0.001

    // a pad's oscilloscope scaled to `peak`, a thin centre line while silent
    export const scope = ({context, actualWidth, actualHeight, devicePixelRatio}: CanvasPainter, values: Float32Array,
                          peak: number, semitone: int): void => {
        const center = actualHeight / 2
        context.strokeStyle = color(semitone)
        context.beginPath()
        if (peak < SilenceLevel) {
            context.globalAlpha = 0.5
            context.lineWidth = devicePixelRatio * 0.5
            context.moveTo(0, center)
            context.lineTo(actualWidth, center)
        } else {
            const scale = 0.9 / values.reduce((max, value) => Math.max(max, Math.abs(value)), peak)
            context.lineWidth = devicePixelRatio
            values.forEach((value, index) => {
                const x = index / (values.length - 1) * actualWidth
                const y = center - value * scale * center
                if (index === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
            })
        }
        context.stroke()
        context.globalAlpha = 1.0
    }

    const layout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
}