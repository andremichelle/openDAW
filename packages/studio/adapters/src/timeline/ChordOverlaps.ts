import {int, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {ChordEventBox} from "@opendaw/studio-boxes"

export namespace ChordOverlaps {
    // the inserted chords stay, chords they cover are shortened, split or removed
    export const resolve = (graph: BoxGraph, chords: ReadonlyArray<ChordEventBox>,
                            inserted: ReadonlyArray<ChordEventBox>): void => {
        const others = chords.filter(chord => !inserted.includes(chord))
        inserted.forEach(chord => {
            const position = chord.position.getValue()
            const complete = position + chord.duration.getValue()
            others.slice().forEach(other => {
                if (!other.isAttached()) {return}
                const start = other.position.getValue()
                const end = start + other.duration.getValue()
                if (start >= complete || end <= position) {return}
                if (start >= position && end <= complete) {
                    other.delete()
                    return
                }
                if (start < position && end > complete) {others.push(copy(graph, other, complete, end - complete))}
                if (start < position) {
                    other.duration.setValue(position - start)
                } else {
                    other.position.setValue(complete)
                    other.duration.setValue(end - complete)
                }
            })
        })
    }

    const copy = (graph: BoxGraph, source: ChordEventBox, position: int, duration: int): ChordEventBox =>
        ChordEventBox.create(graph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.degree.setValue(source.degree.getValue())
            box.shift.setValue(source.shift.getValue())
            box.shape.setValue(source.shape.getValue())
            box.notes.setValue(source.notes.getValue())
            box.inversion.setValue(source.inversion.getValue())
            source.track.targetVertex.ifSome(target => box.track.refer(target))
        })
}
