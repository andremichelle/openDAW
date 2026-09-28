import {Option, unitValue} from "@opendaw/lib-std"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {CanvasPainter} from "@opendaw/studio-core"
import {NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"

export type Region = {start: unitValue, end: unitValue}
export type LoopRange = {lo: unitValue, hi: unitValue, fade: unitValue}

export const resolveRegion = (adapter: NanoDeviceBoxAdapter): Region => {
    const {sampleStart, sampleEnd} = adapter.namedParameter
    return {
        start: Math.min(sampleStart.getValue(), sampleEnd.getValue()),
        end: Math.max(sampleStart.getValue(), sampleEnd.getValue())
    }
}

// The loop range as the device resolves it: clamped into the region, the whole region when degenerate,
// the fade clamped to half the range.
export const resolveLoopRange = (adapter: NanoDeviceBoxAdapter, numFrames: number, sampleRate: number): LoopRange => {
    const {loopStart, loopEnd, loopFade} = adapter.namedParameter
    const {start, end} = resolveRegion(adapter)
    const l0 = Math.max(Math.min(loopStart.getValue(), loopEnd.getValue()), start)
    const l1 = Math.min(Math.max(loopStart.getValue(), loopEnd.getValue()), end)
    const [lo, hi] = (l1 - l0) * numFrames < 1.0 ? [start, end] : [l0, l1]
    const fade = Math.min(loopFade.getValue() * sampleRate / numFrames, (hi - lo) * 0.5)
    return {lo, hi, fade}
}

export const loopRangeOf = (adapter: NanoDeviceBoxAdapter): Option<LoopRange> =>
    adapter.file().flatMap(file => file.data).map(data => resolveLoopRange(adapter, data.numberOfFrames, data.sampleRate))

export const paintWaveform = ({context, width, height}: CanvasPainter, adapter: NanoDeviceBoxAdapter): void => {
    context.clearRect(0, 0, width, height)
    adapter.file().ifSome(file => file.getOrCreateLoader().peaks.ifSome(peaks => {
        const {numFrames, numChannels} = peaks
        const {start, end} = resolveRegion(adapter)
        const wd = (width - 1) * devicePixelRatio
        const fullHeight = height * devicePixelRatio
        const rowHeight = fullHeight / numChannels
        const layout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
        const renderRange = (from: number, to: number, xFrom: number, xTo: number) => {
            for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                layout.u0 = from
                layout.u1 = to
                layout.x0 = xFrom
                layout.x1 = xTo
                layout.y0 = rowHeight * channelIndex
                layout.y1 = rowHeight * (channelIndex + 1)
                PeaksPainter.renderPixelStrips(context, peaks, channelIndex, layout)
            }
        }
        const u0 = start * numFrames
        const u1 = end * numFrames
        const x0 = start * wd
        const x1 = end * wd
        context.fillStyle = Colors.dark.toString()
        renderRange(u0, u1, x0, x1)
        context.fillRect(Math.round(x0), 0, 1, fullHeight)
        context.fillRect(Math.round(x1), 0, 1, fullHeight)
        context.globalAlpha = 0.25
        if (u0 > 0.0) {renderRange(0.0, u0, 0.0, x0)}
        if (u1 < numFrames) {renderRange(u1, numFrames, x1, wd)}
        context.globalAlpha = 1.0
        if (adapter.namedParameter.loop.getValue()) {
            loopRangeOf(adapter).ifSome(({lo, hi, fade}) => {
                const xLo = Math.round(lo * wd)
                const xHi = Math.round(hi * wd)
                const xFadeIn = Math.round((lo + fade) * wd)
                const xFadeOut = Math.round((hi - fade) * wd)
                context.fillStyle = Colors.green.toString()
                context.globalAlpha = 0.2
                context.fillRect(xLo, 0, xFadeIn - xLo, fullHeight)
                context.fillRect(xFadeOut, 0, xHi - xFadeOut, fullHeight)
                context.globalAlpha = 1.0
                context.fillRect(xLo, 0, 1, fullHeight)
                context.fillRect(xHi, 0, 1, fullHeight)
            })
        }
    }))
}
