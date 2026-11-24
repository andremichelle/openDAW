import {BoxGraph} from "@opendaw/lib-box"
import {asInstanceOf} from "@opendaw/lib-std"
import {BoxIO, NoteEventBox, NoteEventChanceBox, NoteEventRepeatBox} from "@opendaw/studio-boxes"

// A chance or repeat box holding only defaults, or the chance box of a grouped note, plays like no box at all.
export const migrateDefaultNoteFeature = (boxGraph: BoxGraph<BoxIO.TypeMap>,
                                          box: NoteEventChanceBox | NoteEventRepeatBox): void => {
    const isDefault = box instanceof NoteEventChanceBox
        ? box.chance.getValue() === 100 || box.event.targetVertex
            .mapOr(vertex => asInstanceOf(vertex.box, NoteEventBox).group.nonEmpty(), false)
        : box.count.getValue() === 1 && box.curve.getValue() === 0.0
        && box.length.getValue() === 1.0 && box.velocityFade.getValue() === 0.0
    if (!isDefault || !box.isAttached()) {return}
    console.debug(`Migrate: delete ${box.name} without effect`)
    boxGraph.beginTransaction()
    box.delete()
    boxGraph.endTransaction()
}
