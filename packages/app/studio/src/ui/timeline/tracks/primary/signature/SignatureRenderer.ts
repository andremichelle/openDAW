import {SignatureEventBoxAdapter, SignatureTrackAdapter} from "@opendaw/studio-adapters"
import {isDefined} from "@opendaw/lib-std"
import {CanvasPainter} from "@/ui/canvas/painter"
import {Context2d} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"

export namespace SignatureRenderer {
    const textPadding = 8 as const

    export const createTrackRenderer = (canvas: HTMLCanvasElement,
                                        range: TimelineRange,
                                        {events}: SignatureTrackAdapter) =>
        new CanvasPainter(canvas, ({context}) => {
            const {width, height} = canvas
            const {fontFamily, fontSize} = getComputedStyle(canvas)
            context.clearRect(0, 0, width, height)
            context.textBaseline = "middle"
            context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
            const renderSignature = (curr: SignatureEventBoxAdapter, next?: SignatureEventBoxAdapter): void => {
                SignatureRenderer.renderSignature(context, range, curr, height, next)
            }
            const unitMin = range.unitMin
            const unitMax = range.unitMax
            const iterator = events.iterateFrom(unitMin)
            const {value, done} = iterator.next()
            if (done) {return}
            let prev: SignatureEventBoxAdapter = value
            for (const curr of iterator) {
                renderSignature(prev, curr)
                prev = curr
                if (curr.position > unitMax) {break}
            }
            renderSignature(prev)
        })

    export const renderSignature = (context: CanvasRenderingContext2D,
                                    range: TimelineRange,
                                    adapter: SignatureEventBoxAdapter,
                                    height: number,
                                    next?: SignatureEventBoxAdapter): void => {
        const x0 = Math.floor(range.unitToX(adapter.position) * devicePixelRatio)
        const label = `${adapter.nominator}/${adapter.denominator}`
        let text: string
        if (isDefined(next)) {
            const x1 = Math.floor(range.unitToX(next.position) * devicePixelRatio)
            const truncate = Context2d.truncateText(context, label, x1 - x0 - textPadding)
            text = truncate.text
        } else {
            text = label
        }
        const vPadding = Math.ceil(height / 5)
        context.fillStyle = Colors.cream.toString()
        context.fillRect(x0, vPadding, 2, height - (vPadding << 1))
        context.fillText(text, x0 + textPadding, height >> 1)
    }

    export const computeWidth = (context: CanvasRenderingContext2D,
                                 adapter: SignatureEventBoxAdapter): number => {
        const label = `${adapter.nominator}/${adapter.denominator}`
        const width = context.measureText(label).width
        return (width + textPadding) / devicePixelRatio
    }
}
