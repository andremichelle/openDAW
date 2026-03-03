import {ElementCapturing} from "../../../../../../../../studio/core/src/ui/canvas/capturing"
import {BinarySearch, int, Nullable, NumberComparator} from "@opendaw/lib-std"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"

export namespace HeaderCapturing {
    export type Target = { type: "track", adapter: TrackBoxAdapter } | { type: "insert", index: int }

    export const install = (element: HTMLElement, manager: TracksManager): ElementCapturing<Target> =>
        new ElementCapturing<Target>(element, {
            capture: (_x: number, y: number): Nullable<Target> => {
                y += manager.scrollableContainer.scrollTop
                if (y > manager.scrollableContainer.scrollHeight - ExtraSpace) {return null}
                const tracks = manager.tracks()
                const trackIndex = BinarySearch
                    .rightMostMapped(tracks, y, NumberComparator, component => component.position)
                if (trackIndex < 0 || trackIndex >= tracks.length) {return null}
                return {type: "track", adapter: tracks[trackIndex].trackBoxAdapter}
            }
        })
}