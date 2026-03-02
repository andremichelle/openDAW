import {NoteRegionBoxAdapter} from "@opendaw/studio-adapters"
import {LoopableRegion} from "@opendaw/lib-dsp"
import {RegionBound, TimelineRange} from "../../index"

export namespace NotesRenderer {
    export const render = (context: CanvasRenderingContext2D,
                           range: TimelineRange,
                           region: NoteRegionBoxAdapter,
                           {top, bottom}: RegionBound,
                           contentColor: string,
                           {rawStart, regionStart, resultStart, resultEnd}: LoopableRegion.LoopCycle) => {
        const collection = region.optCollection.unwrap()
        const height = bottom - top
        context.fillStyle = contentColor
        const padding = 8
        const noteHeight = 5
        const searchStart = Math.floor(resultStart - rawStart)
        const searchEnd = Math.floor(resultEnd - rawStart)
        for (const note of collection.events.iterateRange(searchStart - collection.maxDuration, searchEnd)) {
            const position = rawStart + note.position
            if (position < regionStart) {continue}
            const complete = Math.min(rawStart + note.complete, resultEnd)
            const x0 = Math.floor(range.unitToX(position) * devicePixelRatio)
            const x1 = Math.floor(range.unitToX(complete) * devicePixelRatio)
            const y = top + padding + Math.floor(note.normalizedPitch() * (height - (padding * 2 + noteHeight)))
            context.fillRect(x0, y, Math.max(1, x1 - x0), noteHeight)
        }
    }
}