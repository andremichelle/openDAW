import {ChordEventBoxAdapter, ChordTrackAdapter} from "@opendaw/studio-adapters"

export namespace ChordOverlaps {
    export const resolve = ({events}: ChordTrackAdapter, adapter: ChordEventBoxAdapter,
                            keep: ReadonlyArray<ChordEventBoxAdapter> = []): void => {
        const {position, complete} = adapter
        events.asArray().filter(other => other !== adapter && !keep.includes(other)
            && other.position < complete && other.complete > position)
            .forEach(other => {
                if (other.position >= position && other.complete <= complete) {
                    other.box.delete()
                } else if (other.position < position) {
                    other.box.duration.setValue(position - other.position)
                } else {
                    other.box.duration.setValue(other.complete - complete)
                    other.box.position.setValue(complete)
                }
            })
    }
}
