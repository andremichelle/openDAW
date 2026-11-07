import {Harmony, ppqn} from "@opendaw/lib-dsp"
import {isDefined, Nullable, Predicate, Provider} from "@opendaw/lib-std"
import {ChordEventBoxAdapter, ChordTrackAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"
import {Context2d} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"

export namespace ChordRenderer {
    export interface Modifier {
        readonly copy: boolean
        readonly adapters: ReadonlyArray<ChordEventBoxAdapter>
        readPosition(adapter: ChordEventBoxAdapter): ppqn
        readComplete(adapter: ChordEventBoxAdapter): ppqn
    }

    export const label = (chordTrack: ChordTrackAdapter, event: ChordEventBoxAdapter,
                          position: ppqn = event.position): string => {
        const degree = Harmony.degreeName(event.degree, event.shift)
        return event.resolve(chordTrack.keyTrack.keyAt(position)).match({
            none: () => `${degree} · –`,
            some: chord => `${degree} · ${Harmony.chordName(chord)}`
        })
    }

    export const createTrackRenderer = (canvas: HTMLCanvasElement,
                                        range: TimelineRange,
                                        chordTrack: ChordTrackAdapter,
                                        isSelected: Predicate<ChordEventBoxAdapter>,
                                        modifier: Provider<Nullable<Modifier>>) =>
        new CanvasPainter(canvas, ({context}) => {
            const {width, height} = canvas
            const {fontFamily, fontSize} = getComputedStyle(canvas)
            context.clearRect(0, 0, width, height)
            context.textBaseline = "middle"
            context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
            const vPadding = Math.ceil(height / 8)
            const textPadding = 4 * devicePixelRatio
            const draw = (event: ChordEventBoxAdapter, position: ppqn, complete: ppqn, selected: boolean): void => {
                const x0 = Math.floor(range.unitToX(position) * devicePixelRatio)
                const x1 = Math.floor(range.unitToX(complete) * devicePixelRatio)
                const valid = chordTrack.enabled && event.resolve(chordTrack.keyTrack.keyAt(position)).nonEmpty()
                const color = valid ? Colors.orange : Colors.shadow
                context.fillStyle = (selected ? color : color.opacity(0.1)).toString()
                context.fillRect(x0 + 1, vPadding, Math.max(1, x1 - x0 - 2), height - (vPadding << 1))
                context.fillStyle = (selected ? Colors.panelBackgroundDark : color).toString()
                const {text} = Context2d.truncateText(context, label(chordTrack, event, position), x1 - x0 - textPadding * 2)
                context.fillText(text, x0 + textPadding + 2, height >> 1)
            }
            const active = modifier()
            for (const event of chordTrack.events.iterateFrom(range.unitMin)) {
                if (event.position > range.unitMax) {break}
                if (isDefined(active) && active.adapters.includes(event)) {
                    if (active.copy) {draw(event, event.position, event.complete, false)}
                } else {
                    draw(event, event.position, event.complete, isSelected(event))
                }
            }
            if (!isDefined(active)) {return}
            for (const event of active.adapters) {
                const position = active.readPosition(event)
                const complete = active.readComplete(event)
                if (complete < range.unitMin || position > range.unitMax) {continue}
                draw(event, position, complete, true)
            }
        })
}
