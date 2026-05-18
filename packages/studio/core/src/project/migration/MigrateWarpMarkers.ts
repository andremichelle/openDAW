import {BoxGraph} from "@opendaw/lib-box"
import {asInstanceOf} from "@opendaw/lib-std"
import {AudioPitchStretchBox, AudioTimeStretchBox, BoxIO, WarpMarkerBox} from "@opendaw/studio-boxes"

// Drop duplicate warp markers (same ppqn position) on a stretch box. The sorted
// EventCollection used by AudioPitchStretchBoxAdapter / AudioTimeStretchBoxAdapter
// panics on equal positions; old data with duplicates would make the project
// unloadable.
export const migrateWarpMarkers = (boxGraph: BoxGraph<BoxIO.TypeMap>,
                                   box: AudioPitchStretchBox | AudioTimeStretchBox): void => {
    const markers = [...box.warpMarkers.pointerHub.incoming()].map(({box}) => asInstanceOf(box, WarpMarkerBox))
    const seen = new Set<number>()
    const duplicates: Array<WarpMarkerBox> = []
    for (const marker of markers) {
        const position = marker.position.getValue()
        if (seen.has(position)) {
            duplicates.push(marker)
        } else {
            seen.add(position)
        }
    }
    if (duplicates.length > 0) {
        console.debug(`Migrate '${box.name}': drop ${duplicates.length} duplicate warp marker(s)`)
        boxGraph.beginTransaction()
        duplicates.forEach(duplicate => duplicate.delete())
        boxGraph.endTransaction()
    }
}