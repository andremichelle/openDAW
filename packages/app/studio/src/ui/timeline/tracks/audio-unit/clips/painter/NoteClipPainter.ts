import {PI_HALF, Procedure, TAU} from "@opendaw/lib-std"
import {NoteClipBoxAdapter} from "@opendaw/studio-adapters"
import {CanvasPainter} from "@opendaw/studio-core"

export const createNoteClipPainter = (adapter: NoteClipBoxAdapter): Procedure<CanvasPainter> => painter => {
    const {context, actualHeight: size} = painter
    const radius = size >> 1

    context.save()
    context.lineCap = "butt"
    context.lineJoin = "bevel"

    context.translate(radius, radius)
    const duration = adapter.duration
    const minRadius = 2 * devicePixelRatio
    const maxRadius = radius - 2 * devicePixelRatio
    const collection = adapter.optCollection.unwrap()
    const {minPitch, maxPitch} = collection
    for (const event of collection.events.asArray()) {
        context.beginPath() // TODO move out of loop with moveTo
        context.strokeStyle = `hsl(${adapter.hue}, 50%, 80%)`
        context.lineWidth = devicePixelRatio
        const rangePitch = maxPitch - minPitch
        const normalised = rangePitch === 0 ? 0.5 : 1.0 - (event.pitch - minPitch) / rangePitch
        const a0 = event.position / duration * TAU - PI_HALF
        const a1 = event.complete / duration * TAU - PI_HALF
        const r = minRadius + normalised * (maxRadius - minRadius)
        context.arc(0.0, 0.0, r, a0, a1, false)
        context.stroke()
    }
    context.restore()
}