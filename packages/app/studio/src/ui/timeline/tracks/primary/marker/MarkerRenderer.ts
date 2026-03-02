import {MarkerBoxAdapter, MarkerTrackAdapter} from "@opendaw/studio-adapters"
import {DefaultObservableValue, int, isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {CanvasPainter} from "../../../../../../../../studio/core/src/ui/canvas/painter"
import {Context2d} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"

export namespace MarkerRenderer {
    export const createTrackRenderer = (canvas: HTMLCanvasElement,
                                        range: TimelineRange,
                                        {events}: MarkerTrackAdapter,
                                        markerState: DefaultObservableValue<Nullable<[UUID.Bytes, int]>>) =>
        new CanvasPainter(canvas, ({context}) => {
            const {width, height} = canvas
            const {fontFamily, fontSize} = getComputedStyle(canvas)
            context.clearRect(0, 0, width, height)
            context.textBaseline = "middle"
            context.font = `${parseFloat(fontSize) * devicePixelRatio}px ${fontFamily}`
            const renderMarker = (curr: MarkerBoxAdapter, next?: MarkerBoxAdapter): void => {
                const state: Nullable<[UUID.Bytes, int]> = markerState.getValue()
                const isPlaying = isDefined(state) && UUID.equals(curr.uuid, state[0])
                MarkerRenderer.renderMarker(context, range, curr, height, isPlaying, isDefined(state) ? state[1] : 0, next)
            }
            const unitMin = range.unitMin
            const unitMax = range.unitMax
            const iterator = events.iterateFrom(unitMin)
            const {value, done} = iterator.next()
            if (done) {return}
            let prev: MarkerBoxAdapter = value
            for (const curr of iterator) {
                renderMarker(prev, curr)
                prev = curr
                if (curr.position > unitMax) {break}
            }
            renderMarker(prev)
        })

    export const renderMarker = (context: CanvasRenderingContext2D,
                                 range: TimelineRange,
                                 adapter: MarkerBoxAdapter,
                                 height: number,
                                 isPlaying: boolean,
                                 repeat: int,
                                 next?: MarkerBoxAdapter): void => {
        const x0 = Math.floor(range.unitToX(adapter.position) * devicePixelRatio)
        const label: string = renderLabel(adapter, isPlaying, repeat)
        let text: string
        let width: number
        if (isDefined(next)) {
            const x1 = Math.floor(range.unitToX(next.position) * devicePixelRatio)
            const truncate = Context2d.truncateText(context, label, x1 - x0 - (isPlaying ? textPadding << 2 : textPadding))
            text = truncate.text
            width = truncate.width
        } else {
            text = label
            width = context.measureText(text).width
        }
        const vPadding = Math.ceil(height / 5)
        if (isPlaying) {
            context.beginPath()
            context.roundRect(x0, vPadding, width + textPadding * 2, height - (vPadding << 1), [0, 99, 99, 0])
            context.fillStyle = `hsl(${adapter.hue}, 60%, 40%)`
            context.fill()
            context.fillStyle = `hsl(${adapter.hue}, 60%, 5%)`
            context.fillText(text, x0 + textPadding, height >> 1)
        } else {
            context.fillStyle = `hsl(${adapter.hue}, 60%, 40%)`
            context.fillRect(x0, vPadding, 2, height - (vPadding << 1))
            context.fillText(text, x0 + textPadding, height >> 1)
        }
    }

    export const computeWidth = (context: CanvasRenderingContext2D,
                                 adapter: MarkerBoxAdapter,
                                 isPlaying: boolean,
                                 repeat: int): number => {
        const label: string = renderLabel(adapter, isPlaying, repeat)
        const width = context.measureText(label).width
        if (isPlaying) {
            return (width + textPadding * 2) / devicePixelRatio
        } else {
            return (width + textPadding) / devicePixelRatio
        }
    }

    const renderLabel = (adapter: MarkerBoxAdapter, isPlaying: boolean, repeat: int): string => {
        if (adapter.plays === 1) {
            return adapter.label
        } else if (adapter.plays === 0) {
            return `${adapter.label} ↩`
        } else {
            return isPlaying ? `${adapter.label} ↩${repeat + 1}/${adapter.plays}` : `${adapter.label} ↩${adapter.plays}`
        }
    }

    const textPadding = 8 as const
}