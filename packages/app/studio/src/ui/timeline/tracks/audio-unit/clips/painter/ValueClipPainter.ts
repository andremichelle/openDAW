import {ValueClipBoxAdapter} from "@opendaw/studio-adapters"
import {Point, Procedure, TAU} from "@opendaw/lib-std"
import {ValueEvent} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"

export const createValueClipPainter = (adapter: ValueClipBoxAdapter): Procedure<CanvasPainter> => painter => {
    const {context, actualHeight: size} = painter
    const radius = size >> 1
    const {duration, optCollection} = adapter
    const numRays = 256 // TODO We should make this dependent on the size

    context.save()
    context.translate(radius, radius)
    context.strokeStyle = `hsl(${adapter.hue}, 50%, 80%)`
    context.beginPath()

    const minRadius = 4 * devicePixelRatio
    const maxRadius = radius - 4 * devicePixelRatio

    const polar = (angle: number, value: number): Point => {
        const sin = Math.sin(angle)
        const cos = -Math.cos(angle)
        const r = minRadius + value * (maxRadius - minRadius)
        return {x: sin * r, y: cos * r}
    }
    let move = true
    for (const {position, value} of ValueEvent.quantise(optCollection.unwrap().events, 0, duration, numRays)) {
        if (move) {
            const {x, y} = polar(position / duration * TAU, value)
            context.moveTo(x, y)
            move = false
        } else {
            const {x, y} = polar(position / duration * TAU, value)
            context.lineTo(x, y)
        }
    }
    context.stroke()
    context.restore()
}