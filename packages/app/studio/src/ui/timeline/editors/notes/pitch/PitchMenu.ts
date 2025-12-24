import {BoxEditing} from "@opendaw/lib-box"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {MutableObservableValue, Procedure, Selection} from "@opendaw/lib-std"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {EventCollection} from "@opendaw/lib-dsp"
import {MenuCollector, MenuItem} from "@/ui/model/menu-item.ts"
import {NoteEditorShortcuts} from "@/ui/shortcuts/NoteEditorShortcuts"

export const createPitchMenu = ({editing, snapping, selection, events, stepRecording}: {
    editing: BoxEditing
    snapping: Snapping
    selection: Selection<NoteEventBoxAdapter>
    events: EventCollection<NoteEventBoxAdapter>
    stepRecording: MutableObservableValue<boolean>
}): Procedure<MenuCollector> => {
    const modify = (procedure: Procedure<ReadonlyArray<NoteEventBoxAdapter>>) => {
        const adapters: ReadonlyArray<NoteEventBoxAdapter> = selection.isEmpty() ? events.asArray() : selection.selected()
        if (adapters.length === 0) {return}
        editing.modify(() => procedure(adapters))
    }
    return (collector: MenuCollector) => collector.addItems(
        MenuItem.default({label: "Delete", selectable: !selection.isEmpty()})
            .setTriggerProcedure(() => editing.modify(() => selection.selected()
                .forEach(adapter => adapter.box.delete()))),
        MenuItem.default({
            label: "Step Recording",
            checked: stepRecording.getValue(),
            shortcut: NoteEditorShortcuts["toggle-step-recording"].shortcut.format()
        })
            .setTriggerProcedure(() => stepRecording.setValue(!stepRecording.getValue())),
        MenuItem.default({
            label: "Consolidate",
            selectable: selection.selected().some(adapter => adapter.canConsolidate())
        }).setTriggerProcedure(() => editing.modify(() => {
            const adapters = selection.selected().filter(adapter => adapter.canConsolidate())
            selection.deselectAll()
            adapters.forEach(adapter => selection.select(...adapter.consolidate()))
        })),
        MenuItem.default({label: "Quantize Notes", separatorBefore: true})
            .setTriggerProcedure(() => modify(adapters => adapters.forEach(({box, position}) =>
                box.position.setValue(snapping.round(position))))),
        MenuItem.default({label: "Resize x2"})
            .setTriggerProcedure(() => modify(adapters => {
                const origin = adapters.reduce((min, {position}) => Math.min(min, position), Number.MAX_SAFE_INTEGER)
                adapters.forEach(({box, position, duration}) => {
                    box.position.setValue(((position - origin) << 1) + origin)
                    box.duration.setValue(duration << 1)
                })
            })),
        MenuItem.default({label: "Resize ÷2"})
            .setTriggerProcedure(() => modify(adapters => {
                const origin = adapters.reduce((min, {position}) => Math.min(min, position), Number.MAX_SAFE_INTEGER)
                adapters.forEach(({box, position, duration}) => {
                    box.position.setValue(((position - origin) >> 1) + origin)
                    box.duration.setValue(duration >> 1)
                })
            })),
        MenuItem.default({label: "Inverse"})
            .setTriggerProcedure(() => modify(adapters => {
                const origin = adapters.reduce((minmax, {pitch}) => {
                    minmax[0] = Math.max(minmax[0], pitch)
                    minmax[1] = Math.min(minmax[1], pitch)
                    return minmax
                }, [0, 127])
                adapters.forEach(({box, pitch}) =>
                    box.pitch.setValue(origin[1] - (pitch - origin[0])))
            })),
        MenuItem.default({label: "Reverse"})
            .setTriggerProcedure(() => modify(adapters => {
                const origin = adapters.reduce((minmax, {position}) => {
                    minmax[0] = Math.max(minmax[0], position)
                    minmax[1] = Math.min(minmax[1], position)
                    return minmax
                }, [0, Number.MAX_SAFE_INTEGER])
                adapters.forEach(({box, position}) =>
                    box.position.setValue(origin[1] - (position - origin[0])))
            })),
        MenuItem.default({label: "Transpose"})
            .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                MenuItem.default({label: "+1 semitone"})
                    .setTriggerProcedure(() => modify(adapters => adapters
                        .forEach(({box, pitch}) => box.pitch.setValue(Math.min(127, pitch + 1))))),
                MenuItem.default({label: "-1 semitone"})
                    .setTriggerProcedure(() => modify(adapters => adapters
                        .forEach(({box, pitch}) => box.pitch.setValue(Math.max(0, pitch - 1))))),
                MenuItem.default({label: "+1 octave"})
                    .setTriggerProcedure(() => modify(adapters => adapters
                        .forEach(({box, pitch}) => {
                            const newPitch = pitch + 12
                            if (newPitch <= 127) {box.pitch.setValue(newPitch)}
                        }))),
                MenuItem.default({label: "-1 octave"})
                    .setTriggerProcedure(() => modify(adapters => adapters
                        .forEach(({box, pitch}) => {
                            const newPitch = pitch - 12
                            if (newPitch >= 0) {box.pitch.setValue(newPitch)}
                        })))
            ))
    )
}