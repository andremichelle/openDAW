import {Harmony} from "@opendaw/lib-dsp"
import {isDefined, Nullable} from "@opendaw/lib-std"
import {KeyEventBoxAdapter, KeyTrackAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"
import {Context2d} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"

export namespace KeyRenderer {
    export const textPadding = 8 as const

    export const createTrackRenderer = (canvas: HTMLCanvasElement, range: TimelineRange, keyTrack: KeyTrackAdapter) =>
        new CanvasPainter(canvas, ({context}) => {
            const {width, height} = canvas
            const {fontFamily, fontSize} = getComputedStyle(canvas)
            context.clearRect(0, 0, width, height)
            context.textBaseline = "middle"
            context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
            const {events, enabled} = keyTrack
            const color = enabled ? Colors.green : Colors.shadow
            const vPadding = Math.ceil(height / 5)
            const render = (position: number, label: string, implicit: boolean, next: Nullable<KeyEventBoxAdapter>) => {
                const x0 = Math.floor(range.unitToX(position) * devicePixelRatio)
                const maxWidth = isDefined(next)
                    ? Math.floor(range.unitToX(next.position) * devicePixelRatio) - x0 - textPadding * 2
                    : Number.POSITIVE_INFINITY
                const {text} = Context2d.truncateText(context, label, maxWidth)
                context.fillStyle = (implicit ? Colors.shadow : color).toString()
                if (!implicit) {context.fillRect(x0, vPadding, 2, height - (vPadding << 1))}
                context.fillText(text, x0 + textPadding, height >> 1)
            }
            const first = events.first()
            if (!isDefined(first) || first.position > 0) {
                render(0, Harmony.keyName(keyTrack.storageKey), true, first)
            }
            const iterator = events.iterateFrom(range.unitMin)
            const {value, done} = iterator.next()
            if (done) {return}
            let prev: KeyEventBoxAdapter = value
            for (const curr of iterator) {
                render(prev.position, Harmony.keyName(prev.key), false, curr)
                prev = curr
                if (curr.position > range.unitMax) {break}
            }
            render(prev.position, Harmony.keyName(prev.key), false, null)
        })

    export const computeWidth = (context: CanvasRenderingContext2D, adapter: KeyEventBoxAdapter): number =>
        (context.measureText(Harmony.keyName(adapter.key)).width + textPadding) / devicePixelRatio
}
