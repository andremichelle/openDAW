import {Nullable} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, CaptureAudioBox, CaptureMidiBox, TrackBox} from "@opendaw/studio-boxes"
import {TrackType} from "@opendaw/studio-adapters"

// A MIDI instrument replaced with a Tape (or vice versa) can leave an audio unit whose capture device no
// longer matches its content tracks: a Tape (CaptureAudio) unit still holding NOTE tracks, or a MIDI
// (CaptureMidi) unit holding AUDIO tracks. That orphaned structure is unusable and crashes editors (e.g.
// NoteEditor's "No CaptureMidi available"). Delete the mismatched CONTENT tracks — their regions, clips and
// event collections cascade through the mandatory pointers — while leaving automation (Value) tracks intact.
export const migrateCaptureTrackMismatch = (boxGraph: BoxGraph<BoxIO.TypeMap>): void => {
    const orphaned: Array<TrackBox> = []
    for (const box of boxGraph.boxes()) {
        if (!(box instanceof AudioUnitBox)) {continue}
        const captureBox = box.capture.targetVertex.unwrapOrNull()?.box
        const expected: Nullable<TrackType> =
            captureBox instanceof CaptureMidiBox ? TrackType.Notes
                : captureBox instanceof CaptureAudioBox ? TrackType.Audio
                    : null
        if (expected === null) {continue}
        for (const pointer of box.tracks.pointerHub.incoming()) {
            const track = pointer.box
            if (!(track instanceof TrackBox)) {continue}
            const type = track.type.getValue()
            // Only the main content tracks are bound to the capture type; automation (Value) tracks are valid
            // on any unit, so leave them alone.
            if ((type === TrackType.Notes || type === TrackType.Audio) && type !== expected) {
                orphaned.push(track)
            }
        }
    }
    if (orphaned.length === 0) {return}
    console.debug(`Migrate remove ${orphaned.length} capture-mismatched track(s)`)
    boxGraph.beginTransaction()
    orphaned.forEach(track => track.delete())
    boxGraph.endTransaction()
}
