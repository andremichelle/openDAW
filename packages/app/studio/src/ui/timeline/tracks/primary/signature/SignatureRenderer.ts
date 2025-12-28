import {SignatureEvent, SignatureTrackAdapter} from "@opendaw/studio-adapters"
import {isDefined} from "@opendaw/lib-std"
import {CanvasPainter} from "@/ui/canvas/painter"
import {Context2d} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"

export namespace SignatureRenderer {
    const textPadding = 8 as const

    export const forTrack = (canvas: HTMLCanvasElement,
                             range: TimelineRange,
                             trackAdapter: SignatureTrackAdapter) => new CanvasPainter(canvas, ({context}) => {
        const {width, height} = canvas
        const {fontFamily, fontSize} = getComputedStyle(canvas)
        context.clearRect(0, 0, width, height)
        context.textBaseline = "middle"
        context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
        const unitMin = range.unitMin
        const unitMax = range.unitMax
        const signatures = [...trackAdapter.iterateAll()]
        for (let i = 0; i < signatures.length; i++) {
            const curr = signatures[i]
            const next = signatures[i + 1]
            if (isDefined(next) && next.accumulatedPpqn < unitMin) {continue}
            if (curr.accumulatedPpqn > unitMax) {break}
            renderSignature(context, range, curr, height, next)
        }
    })

    const renderSignature = (context: CanvasRenderingContext2D,
                             range: TimelineRange,
                             signature: SignatureEvent,
                             height: number,
                             next?: SignatureEvent): void => {
        const x0 = Math.floor(range.unitToX(signature.accumulatedPpqn) * devicePixelRatio)
        const label = `${signature.nominator}/${signature.denominator}`
        let text: string
        if (isDefined(next)) {
            const x1 = Math.floor(range.unitToX(next.accumulatedPpqn) * devicePixelRatio)
            const truncate = Context2d.truncateText(context, label, x1 - x0 - textPadding)
            text = truncate.text
        } else {
            text = label
        }
        const vPadding = Math.ceil(height / 5)
        context.fillStyle = Colors.dark.toString()
        context.fillRect(x0, vPadding, 2, height - (vPadding << 1))
        context.fillText(text, x0 + textPadding, height >> 1)
    }

    export const computeWidth = (context: CanvasRenderingContext2D,
                                 signature: SignatureEvent): number => {
        const label = `${signature.nominator}/${signature.denominator}`
        const width = context.measureText(label).width
        return (width + textPadding) / devicePixelRatio
    }
}
