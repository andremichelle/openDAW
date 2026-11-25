import {BoxGraph} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {BoxIO, NoteEventBox, NoteEventChanceBox, NoteEventRepeatBox} from "@opendaw/studio-boxes"

// Moves the deprecated chance (25), play-count (22) and play-curve (23) into aux boxes. Deprecated fields are not saved again.
export const migrateNoteEventBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, eventBox: NoteEventBox): void => {
    const chance = eventBox.chance.getValue()
    const playCount = eventBox.playCount.getValue()
    const playCurve = eventBox.playCurve.getValue()
    if (chance === 100 && playCount === 1 && playCurve === 0.0) {return}
    console.debug("Migrate 'NoteEventBox' chance and repeat to aux boxes")
    boxGraph.beginTransaction()
    if (chance !== 100 && eventBox.random.pointerHub.isEmpty()) {
        NoteEventChanceBox.create(boxGraph, UUID.generate(), box => {
            box.event.refer(eventBox.random)
            box.chance.setValue(chance)
        })
    }
    if ((playCount !== 1 || playCurve !== 0.0) && eventBox.split.pointerHub.isEmpty()) {
        NoteEventRepeatBox.create(boxGraph, UUID.generate(), box => {
            box.event.refer(eventBox.split)
            box.count.setValue(playCount)
            box.curve.setValue(playCurve)
        })
    }
    boxGraph.endTransaction()
}
