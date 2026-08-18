import {ContextMenu, MenuItem, MIDILearning} from "@opendaw/studio-core"
import {
    AudioUnitTracks,
    AutomatableParameterFieldAdapter,
    isModulatorBoxAdapter,
    ModulatorBoxAdapter,
    Modulators,
    TrackType
} from "@opendaw/studio-adapters"
import {PrimitiveValues} from "@opendaw/lib-box"
import {Editing, UUID} from "@opendaw/lib-std"

export const attachParameterContextMenu = <T extends PrimitiveValues>(editing: Editing,
                                                                      midiDevices: MIDILearning,
                                                                      tracks: AudioUnitTracks,
                                                                      parameter: AutomatableParameterFieldAdapter<T>,
                                                                      element: Element,
                                                                      disableAutomation?: boolean) =>
    ContextMenu.subscribe(element, collector => {
        const field = parameter.field
        const automation = tracks.controls(field)
        collector.addItems(
            automation.isEmpty()
                ? MenuItem.default({label: "Create Automation", hidden: disableAutomation})
                    .setTriggerProcedure(() => editing.modify(() => {
                        if (parameter.track.nonEmpty()) {return}
                        tracks.create(TrackType.Value, field)
                    }))
                : MenuItem.default({label: "Remove Automation", hidden: disableAutomation})
                    .setTriggerProcedure(() => editing.modify(() =>
                        parameter.track.ifSome(track => tracks.delete(track)))),
            modulationMenu(editing, parameter),
            MenuItem.default({
                label: midiDevices.hasMidiConnection(field.address)
                    ? "Forget Midi"
                    : "Learn Midi Control..."
            }).setTriggerProcedure(() => {
                if (midiDevices.hasMidiConnection(field.address)) {
                    midiDevices.forgetMidiConnection(field.address)
                } else {
                    midiDevices.learnMIDIControls(field).then()
                }
            }),
            MenuItem.default({label: "Reset Value", checked: field.getValue() === field.initValue})
                .setTriggerProcedure(() => editing.modify(() => parameter.reset()))
        )
    })

const modulationMenu = <T extends PrimitiveValues>(editing: Editing,
                                                   parameter: AutomatableParameterFieldAdapter<T>) =>
    MenuItem.default({label: "Modulate"}).setRuntimeChildrenProcedure(parent => {
        const context = parameter.context
        const target = parameter.modulationTarget
        const assigned = parameter.modulations
        const assignedSources = new Set(assigned
            .map(box => box.source.targetVertex.mapOr(vertex => UUID.toString(vertex.address.uuid), ""))
            .filter(uuid => uuid.length > 0))
        parent.addMenuItem(MenuItem.default({label: "New LFO"})
            .setTriggerProcedure(() => editing.modify(() =>
                Modulators.assign(context, Modulators.createLfo(context), target))))
        parent.addMenuItem(MenuItem.default({label: "New Steps"})
            .setTriggerProcedure(() => editing.modify(() =>
                Modulators.assign(context, Modulators.createSteps(context), target))))
        context.rootBoxAdapter.modulators.adapters().forEach((modulator: ModulatorBoxAdapter) => {
            const alreadyAssigned = assignedSources.has(UUID.toString(modulator.uuid))
            parent.addMenuItem(MenuItem.default({
                label: modulator.label,
                checked: alreadyAssigned,
                selectable: !alreadyAssigned,
                separatorBefore: modulator.indexField.getValue() === 0
            }).setTriggerProcedure(() => editing.modify(() => Modulators.assign(context, modulator.box, target))))
        })
        assigned.forEach((box, index) => {
            const label = box.source.targetVertex
                .map(vertex => context.boxAdapters.adapterFor(vertex.box, isModulatorBoxAdapter).label)
                .unwrapOrElse("Modulator")
            parent.addMenuItem(MenuItem.default({label: `Remove ${label}`, separatorBefore: index === 0})
                .setTriggerProcedure(() => editing.modify(() => box.delete())))
        })
    })
