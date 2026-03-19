import {ContextMenu, MenuItem, MIDILearning} from "@moises-ai/studio-core"
import {AudioUnitTracks, AutomatableParameterFieldAdapter, TrackType} from "@moises-ai/studio-adapters"
import {PrimitiveValues} from "@moises-ai/lib-box"
import {Editing} from "@moises-ai/lib-std"

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
                    .setTriggerProcedure(() => editing.modify(() =>
                        tracks.create(TrackType.Value, field)))
                : MenuItem.default({label: "Remove Automation", hidden: disableAutomation})
                    .setTriggerProcedure(() => editing.modify(() =>
                        tracks.delete(automation.unwrap()))),
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