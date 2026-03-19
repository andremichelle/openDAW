import {asDefined, Editing, int, Procedure, Selection} from "@moises-ai/lib-std"
import {ValueEventBoxAdapter} from "@moises-ai/studio-adapters"
import {EventCollection, ppqn} from "@moises-ai/lib-dsp"
import {MenuCollector, MenuItem} from "@moises-ai/studio-core"

export const createValueMenu = ({editing, selection, events}: {
    editing: Editing
    selection: Selection<ValueEventBoxAdapter>
    events: EventCollection<ValueEventBoxAdapter>
}): Procedure<MenuCollector> => {
    const modify = (procedure: Procedure<ReadonlyArray<ValueEventBoxAdapter>>) => {
        const adapters: ReadonlyArray<ValueEventBoxAdapter> = selection.isEmpty() ? events.asArray() : selection.selected()
        if (adapters.length === 0) {return}
        editing.modify(() => procedure(adapters))
    }
    return (collector: MenuCollector) => collector.addItems(
        MenuItem.default({label: "Delete", selectable: !selection.isEmpty()})
            .setTriggerProcedure(() => editing.modify(() => selection.selected()
                .forEach(adapter => adapter.box.delete()))),
        MenuItem.default({label: "Inverse", separatorBefore: true})
            .setTriggerProcedure(() => modify(adapters => adapters
                .forEach(({box, value}) => box.value.setValue(1.0 - value)))),
        MenuItem.default({label: "Reverse"})
            .setTriggerProcedure(() => modify(adapters => {
                let min = Number.MAX_SAFE_INTEGER
                let max = 0
                const counts = new Map<ppqn, int>()
                adapters.forEach(({position}) => {
                    min = Math.min(min, position)
                    max = Math.max(max, position)
                    counts.set(position, (counts.get(position) ?? 0) + 1)
                })
                adapters.forEach(({box, position, index}) => {
                    box.position.setValue(min + (max - position))
                    if (asDefined(counts.get(position)) > 1) {
                        box.index.setValue(index === 0 ? 1 : 0)
                    }
                })
            }))
    )
}
