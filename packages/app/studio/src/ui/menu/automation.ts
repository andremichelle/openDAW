import {ContextMenu, MenuItem, MIDILearning} from "@opendaw/studio-core"
import {
    AudioUnitTracks,
    AutomatableParameterFieldAdapter,
    ModulatorBoxAdapter,
    Modulators,
    TrackType
} from "@opendaw/studio-adapters"
import {PrimitiveValues} from "@opendaw/lib-box"
import {ModulatorReveal} from "@/ui/modulation/ModulatorReveal.ts"
import {Editing, isDefined, UUID} from "@opendaw/lib-std"

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

/// The lane owner is the modulator itself, registered when its parameters were created.
const modulatorParameterItems = <T extends PrimitiveValues>(editing: Editing,
                                                            midiDevices: MIDILearning,
                                                            parameter: AutomatableParameterFieldAdapter<T>) => {
    const field = parameter.field
    const owner = parameter.context.parameterFieldAdapters.getTracks(field.address)
    const automation = owner.flatMap(tracks => tracks.controls(field))
    return [
        automation.isEmpty()
            ? MenuItem.default({label: "Create Automation", selectable: owner.nonEmpty()})
                .setTriggerProcedure(() => editing.modify(() =>
                    owner.ifSome(tracks => tracks.create(TrackType.Value, field))))
            : MenuItem.default({label: "Remove Automation"})
                .setTriggerProcedure(() => editing.modify(() =>
                    automation.ifSome(track => owner.unwrap("no lane owner").delete(track)))),
        MenuItem.default({
            label: midiDevices.hasMidiConnection(field.address) ? "Forget Midi" : "Learn Midi Control..."
        }).setTriggerProcedure(() => {
            if (midiDevices.hasMidiConnection(field.address)) {
                midiDevices.forgetMidiConnection(field.address)
            } else {
                midiDevices.learnMIDIControls(field).then()
            }
        }),
        MenuItem.default({label: "Reset Value", checked: field.getValue() === field.initValue})
            .setTriggerProcedure(() => editing.modify(() => parameter.reset()))
    ]
}

export const attachModulatorParameterContextMenu = <T extends PrimitiveValues>(
    editing: Editing,
    midiDevices: MIDILearning,
    parameter: AutomatableParameterFieldAdapter<T>,
    element: Element) =>
    ContextMenu.subscribe(element, collector =>
        collector.addItems(...modulatorParameterItems(editing, midiDevices, parameter)))

export const attachAssignmentDepthContextMenu = <T extends PrimitiveValues>(
    editing: Editing,
    midiDevices: MIDILearning,
    parameter: AutomatableParameterFieldAdapter<T>,
    element: Element) =>
    ContextMenu.subscribe(element, collector => collector.addItems(
        ...modulatorParameterItems(editing, midiDevices, parameter),
        modulationMenu(editing, parameter)
    ))

const modulationMenu = <T extends PrimitiveValues>(editing: Editing,
                                                   parameter: AutomatableParameterFieldAdapter<T>) =>
    MenuItem.default({label: "Modulate"}).setRuntimeChildrenProcedure(parent => {
        const context = parameter.context
        const target = parameter.modulationTarget
        const assignments = new Map(parameter.modulations
            .map(box => [box.source.targetVertex
                .mapOr(vertex => UUID.toString(vertex.address.uuid), ""), box] as const)
            .filter(([uuid]) => uuid.length > 0))
        parent.addMenuItem(MenuItem.default({label: "New"}).setRuntimeChildrenProcedure(sub =>
            sub.addMenuItem(...Modulators.Kinds.map(kind => MenuItem.default({label: kind.label})
                .setTriggerProcedure(() => {
                    const modulator = editing.modify(() => {
                        const modulator = kind.create(context)
                        Modulators.assign(context, modulator, target)
                        return modulator
                    })
                    modulator.ifSome(box => ModulatorReveal.request(box.address.uuid))
                })))))
        context.rootBoxAdapter.modulators.adapters().forEach((modulator: ModulatorBoxAdapter) => {
            const assignment = assignments.get(UUID.toString(modulator.uuid))
            parent.addMenuItem(MenuItem.default({
                label: modulator.label,
                checked: isDefined(assignment),
                separatorBefore: modulator.indexField.getValue() === 0
            }).setTriggerProcedure(() => editing.modify(() => isDefined(assignment)
                ? assignment.delete()
                : Modulators.assign(context, modulator.box, target))))
        })
    })
