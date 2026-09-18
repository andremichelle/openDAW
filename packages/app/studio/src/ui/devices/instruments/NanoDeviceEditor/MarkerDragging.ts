import {clamp, Editing, Option, Terminable} from "@opendaw/lib-std"
import {Dragging} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter, NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {SnapValueThresholdInPixels} from "@/ui/timeline/editors/value/ValueMoveModifier"
import {loopRangeOf} from "./WaveformPainter"

type Marker = {parameter: AutomatableParameterFieldAdapter, delta: number}

const nearest = (markers: ReadonlyArray<Marker>): Option<Marker> => {
    const candidates = markers.filter(marker => Math.abs(marker.delta) <= SnapValueThresholdInPixels)
    return candidates.length === 0
        ? Option.None
        : Option.wrap(candidates.reduce((best, marker) => Math.abs(marker.delta) < Math.abs(best.delta) ? marker : best))
}

// Drag the region markers, or the loop markers while looping. A region marker within reach always wins.
export const attachMarkerDragging = (canvas: HTMLCanvasElement, editing: Editing, adapter: NanoDeviceBoxAdapter): Terminable =>
    Dragging.attach(canvas, ({clientX}: PointerEvent) => {
        const {left, width} = canvas.getBoundingClientRect()
        const {sampleStart, sampleEnd, loop, loopStart, loopEnd} = adapter.namedParameter
        const delta = (position: number) => clientX - (left + position * width)
        const region = nearest([
            {parameter: sampleStart, delta: delta(sampleStart.getValue())},
            {parameter: sampleEnd, delta: delta(sampleEnd.getValue())}
        ])
        const loopMarkers = loop.getValue() ? loopRangeOf(adapter).map(({lo, hi}) => {
            const [loParameter, hiParameter] = loopStart.getValue() <= loopEnd.getValue() ? [loopStart, loopEnd] : [loopEnd, loopStart]
            return nearest([{parameter: loParameter, delta: delta(lo)}, {parameter: hiParameter, delta: delta(hi)}])
        }).unwrapOrElse(Option.None) : Option.None
        const marker: Option<Marker> = region.match({some: found => Option.wrap(found), none: () => loopMarkers})
        return marker.map(({parameter, delta}) => ({
            update: ({clientX}: Dragging.Event): void => {
                const {left, width} = canvas.getBoundingClientRect()
                editing.modify(() => parameter.setValue(clamp((clientX - delta - left) / width, 0.0, 1.0)), false)
            },
            cancel: () => editing.revertPending(),
            approve: () => editing.mark()
        } satisfies Dragging.Process))
    })
