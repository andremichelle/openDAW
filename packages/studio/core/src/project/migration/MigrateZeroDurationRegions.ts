import {BoxGraph} from "@opendaw/lib-box"
import {AudioRegionBox, BoxIO, NoteRegionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {PPQN, ppqn, TimeBase} from "@opendaw/lib-dsp"

type AnyRegionBox = AudioRegionBox | NoteRegionBox | ValueRegionBox

// A region whose (derived) ppqn duration is <= 0 is invalid: it is invisible, cannot play, and trips
// validateTrack ("duration(0) must be positive") on the very next timeline edit. The root cause — zero-length
// audio samples producing duration-0 audio regions — is now fixed at sample import, but projects saved while
// the bug was live still carry these regions. Drop them at load so they can never crash an edit again.
export const migrateZeroDurationRegions = (boxGraph: BoxGraph<BoxIO.TypeMap>, bpm: number): void => {
    // Mirror the adapter/validateTrack notion of duration: seconds-based audio regions derive their ppqn
    // duration through the tempo; everything else stores ppqn directly. `!(x > 0)` also catches NaN.
    const durationPPQN = (box: AnyRegionBox): ppqn =>
        box instanceof AudioRegionBox && box.timeBase.getValue() === TimeBase.Seconds
            ? PPQN.secondsToPulses(box.duration.getValue(), bpm)
            : box.duration.getValue()
    const invalid = boxGraph.boxes().filter((box): box is AnyRegionBox =>
        (box instanceof AudioRegionBox || box instanceof NoteRegionBox || box instanceof ValueRegionBox)
        && !(durationPPQN(box) > 0))
    if (invalid.length === 0) {return}
    console.debug(`Migrate remove ${invalid.length} zero-duration region(s)`)
    boxGraph.beginTransaction()
    invalid.forEach(box => box.delete())
    boxGraph.endTransaction()
}
