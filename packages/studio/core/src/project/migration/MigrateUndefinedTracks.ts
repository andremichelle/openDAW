import {BoxGraph} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, TrackBox} from "@opendaw/studio-boxes"
import {TrackType} from "@opendaw/studio-adapters"

// TrackType.Undefined was a placeholder giving track-less units (buses, aux) a timeline lane. The timeline
// now renders a synthetic unit lane whenever a unit has no notes/audio track, so the placeholder boxes are
// deleted; the remaining tracks of each affected unit are compacted to a contiguous 0..n-1 index sequence
// (preserving relative order). The enum VALUE stays reserved — stored projects contain it.
export const migrateUndefinedTracks = (boxGraph: BoxGraph<BoxIO.TypeMap>): void => {
    const orphaned: Array<TrackBox> = []
    const affectedUnits: Array<AudioUnitBox> = []
    for (const box of boxGraph.boxes()) {
        if (!(box instanceof AudioUnitBox)) {continue}
        const undefinedTracks = box.tracks.pointerHub.incoming()
            .map(pointer => pointer.box)
            .filter((track): track is TrackBox => track instanceof TrackBox
                && track.type.getValue() === TrackType.Undefined)
        if (undefinedTracks.length > 0) {
            orphaned.push(...undefinedTracks)
            affectedUnits.push(box)
        }
    }
    if (orphaned.length === 0) {return}
    console.debug(`Migrate remove ${orphaned.length} undefined placeholder track(s)`)
    boxGraph.beginTransaction()
    orphaned.forEach(track => track.delete())
    affectedUnits.forEach(unit => unit.tracks.pointerHub.incoming()
        .map(pointer => pointer.box)
        .filter((track): track is TrackBox => track instanceof TrackBox)
        .toSorted((a, b) => a.index.getValue() - b.index.getValue())
        .forEach((track, index) => {
            if (track.index.getValue() !== index) {track.index.setValue(index)}
        }))
    boxGraph.endTransaction()
}
