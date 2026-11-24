import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, NoteEventChanceBox, NoteEventRepeatBox} from "@opendaw/studio-boxes"

// A chance or repeat box that only holds defaults plays like no box at all.
export const migrateDefaultNoteFeature = (boxGraph: BoxGraph<BoxIO.TypeMap>,
                                          box: NoteEventChanceBox | NoteEventRepeatBox): void => {
    const isDefault = box instanceof NoteEventChanceBox
        ? box.chance.getValue() === 100
        : box.count.getValue() === 1 && box.curve.getValue() === 0.0
        && box.length.getValue() === 1.0 && box.velocityFade.getValue() === 0.0
    if (!isDefault || !box.isAttached()) {return}
    console.debug(`Migrate: delete ${box.name} holding only defaults`)
    boxGraph.beginTransaction()
    box.delete()
    boxGraph.endTransaction()
}
