import {Harmony} from "@opendaw/lib-dsp"
import {Nullable} from "@opendaw/lib-std"
import {ChordEventBoxAdapter, ChordTrackAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"
import {Context2d} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"

export namespace ChordRenderer {
    export const label = (chordTrack: ChordTrackAdapter, event: ChordEventBoxAdapter): string => {
        const degree = Harmony.degreeName(event.degree, event.shift)
        return chordTrack.resolve(event).match({
            none: () => `${degree} · –`,
            some: chord => `${degree} · ${Harmony.chordName(chord)}`
        })
    }

    export const createTrackRenderer = (canvas: HTMLCanvasElement,
                                        range: TimelineRange,
                                        chordTrack: ChordTrackAdapter,
                                        selected: () => Nullable<ChordEventBoxAdapter>) =>
        new CanvasPainter(canvas, ({context}) => {
            const {width, height} = canvas
            const {fontFamily, fontSize} = getComputedStyle(canvas)
            context.clearRect(0, 0, width, height)
            context.textBaseline = "middle"
            context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
            const vPadding = Math.ceil(height / 8)
            const textPadding = 4 * devicePixelRatio
            for (const event of chordTrack.events.iterateFrom(range.unitMin)) {
                if (event.position > range.unitMax) {break}
                const x0 = Math.floor(range.unitToX(event.position) * devicePixelRatio)
                const x1 = Math.floor(range.unitToX(event.complete) * devicePixelRatio)
                const valid = chordTrack.enabled && chordTrack.resolve(event).nonEmpty()
                const color = valid ? Colors.orange : Colors.shadow
                const isSelected = event === selected()
                context.fillStyle = (isSelected ? color : color.opacity(0.2)).toString()
                context.fillRect(x0 + 1, vPadding, Math.max(1, x1 - x0 - 2), height - (vPadding << 1))
                context.fillStyle = (isSelected ? Colors.panelBackgroundDark : color).toString()
                if (!isSelected) {context.fillRect(x0 + 1, vPadding, 2, height - (vPadding << 1))}
                const {text} = Context2d.truncateText(context, label(chordTrack, event), x1 - x0 - textPadding * 2)
                context.fillText(text, x0 + textPadding + 2, height >> 1)
            }
        })
}
