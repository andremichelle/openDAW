import {DeviceHost, Devices, EffectDeviceBoxAdapter, PresetDecoder, PresetEncoder} from "@opendaw/studio-adapters"
import {MenuItem} from "@/ui/model/menu-item.ts"
import {BoxEditing, PrimitiveField, PrimitiveValues, StringField} from "@opendaw/lib-box"
import {EmptyExec, isInstanceOf, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {StudioService} from "@/service/StudioService"
import {EffectFactories, FilePickerAcceptTypes, Project} from "@opendaw/studio-core"
import {VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {Files} from "@opendaw/lib-dom"

export namespace MenuItems {
    export const forAudioUnitInput = (parent: MenuItem, service: StudioService, deviceHost: DeviceHost): void => {
        const {project} = service
        const {editing, api} = project
        const audioUnit = deviceHost.audioUnitBoxAdapter()
        const canProcessMidi = deviceHost.inputAdapter.mapOr(input => input.accepts === "midi", false)
        parent.addMenuItem(
            MenuItem.default({
                label: `Delete '${audioUnit.label}'`,
                hidden: audioUnit.isOutput
            }).setTriggerProcedure(() => editing.modify(() => project.api.deleteAudioUnit(audioUnit.box))),
            populateMenuItemToRenameDevice(editing, audioUnit.inputAdapter.unwrap().labelField),
            MenuItem.default({label: "Add Midi-Effect", separatorBefore: true, selectable: canProcessMidi})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.MidiList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(deviceHost.midiEffects.field(), entry, 0))))
                )),
            MenuItem.default({label: "Add Audio Effect"})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.AudioList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(deviceHost.audioEffects.field(), entry, 0))))
                )),
            MenuItem.default({label: "Save Preset..."})
                .setTriggerProcedure(async () => {
                    const presetBytes = PresetEncoder.encode(audioUnit.box)
                    await Files.save(presetBytes as ArrayBuffer, {
                        types: [FilePickerAcceptTypes.PresetFileType],
                        suggestedName: `${audioUnit.label}.odp`
                    })
                }),
            MenuItem.default({label: "Load Preset..."})
                .setTriggerProcedure(async () => {
                    const keepEffects = !(await RuntimeNotifier.approve({
                        headline: "Load Preset",
                        message: "Replace current effects?",
                        approveText: "Yes",
                        cancelText: "No"
                    }))
                    const files = await Files.open({types: [FilePickerAcceptTypes.PresetFileType], multiple: false})
                    if (files.length === 0) {return}
                    const arrayBuffer = await files[0].arrayBuffer()
                    editing.modify(() => {
                        const attempt = PresetDecoder.replaceAudioUnit(arrayBuffer, audioUnit.box, {
                            keepMIDIEffects: keepEffects,
                            keepAudioEffects: keepEffects
                        })
                        if (attempt.isFailure()) {
                            RuntimeNotifier.info({headline: "Can't do...", message: attempt.failureReason()}).then()
                        }
                    })
                }),
            MenuItem.default({
                label: "Load Deprecated Preset...",
                hidden: location.hash !== "#riffle"
            }).setTriggerProcedure(async () => {
                const files = await Files.open({types: [FilePickerAcceptTypes.JsonFileType]})
                if (files.length === 0) {return}
                const string = new TextDecoder().decode(await files[0].arrayBuffer())
                const json = JSON.parse(string)
                if (json["2"] !== "Vaporisateur") {
                    await RuntimeNotifier.info({
                        headline: "Cannot Load Preset",
                        message: "This feature is deprecated (code: 0)."
                    })
                }
                delete json["1"]
                const input = audioUnit.box.input.pointerHub.incoming().at(0)?.box
                if (!isInstanceOf(input, VaporisateurDeviceBox)) {
                    await RuntimeNotifier.info({
                        headline: "Cannot Load Preset",
                        message: "This feature is deprecated (code: 1)."
                    })
                    return
                }
                editing.modify(() => input.fromJSON(json))
            })
        )
    }

    export const createForValue = <V extends PrimitiveValues>(editing: BoxEditing,
                                                              label: string,
                                                              primitive: PrimitiveField<V, any>,
                                                              value: V) =>
        MenuItem.default({label, checked: primitive.getValue() === value})
            .setTriggerProcedure(() => editing.modify(() => primitive.setValue(value)))

    export const forEffectDevice = (parent: MenuItem,
                                    service: StudioService,
                                    host: DeviceHost,
                                    device: EffectDeviceBoxAdapter): void => {
        const {project} = service
        const {editing} = project
        parent.addMenuItem(
            populateMenuItemToDeleteDevice(editing, device),
            populateMenuItemToCreateEffect(service, host, device),
            populateMenuItemToMoveEffect(project, host, device)
        )
    }

    const populateMenuItemToRenameDevice = (editing: BoxEditing, labelField: StringField) =>
        MenuItem.default({label: "Rename..."}).setTriggerProcedure(() => {
            const resolvers = Promise.withResolvers<string>()
            const surface = Surface.get()
            surface.flyout.appendChild(FloatingTextInput({
                position: surface.pointer,
                value: labelField.getValue(),
                resolvers
            }))
            resolvers.promise.then(newName => editing.modify(() => labelField.setValue(newName)), EmptyExec)
        })

    const populateMenuItemToDeleteDevice = (editing: BoxEditing, ...devices: ReadonlyArray<EffectDeviceBoxAdapter>) => {
        const label = `Delete '${devices.map(device => device.labelField.getValue()).join(", ")}'`
        return MenuItem.default({label})
            .setTriggerProcedure(() => editing.modify(() => Devices.deleteEffectDevices(devices)))
    }

    const populateMenuItemToCreateEffect = (service: StudioService, host: DeviceHost, adapter: EffectDeviceBoxAdapter) => {
        const {project} = service
        const {editing, api} = project
        return adapter.accepts === "audio"
            ? MenuItem.default({label: "Add Audio Effect", separatorBefore: true})
                .setRuntimeChildrenProcedure(parent => parent
                    .addMenuItem(...EffectFactories.AudioList
                        .map(factory => MenuItem.default({
                            label: factory.defaultName,
                            separatorBefore: factory.separatorBefore
                        }).setTriggerProcedure(() =>
                            editing.modify(() => api.insertEffect(host.audioEffects.field(), factory, adapter.indexField.getValue() + 1))))
                    ))
            : adapter.accepts === "midi"
                ? MenuItem.default({label: "Add Midi Effect", separatorBefore: true})
                    .setRuntimeChildrenProcedure(parent => parent
                        .addMenuItem(...EffectFactories.MidiList
                            .map(factory => MenuItem.default({
                                label: factory.defaultName,
                                separatorBefore: factory.separatorBefore
                            }).setTriggerProcedure(() => editing.modify(() => api
                                .insertEffect(host.midiEffects.field(), factory, adapter.indexField.getValue() + 1))))
                        )) : panic(`Unknown accepts value: ${adapter.accepts}`)
    }

    const populateMenuItemToMoveEffect = ({editing}: Project, host: DeviceHost, adapter: EffectDeviceBoxAdapter) => {
        const adapters: ReadonlyArray<EffectDeviceBoxAdapter> =
            adapter.accepts === "audio"
                ? host.audioEffects.adapters()
                : adapter.accepts === "midi"
                    ? host.midiEffects.adapters()
                    : panic(`Unknown accept type: ${adapter.accepts}`)
        const index = adapter.indexField.getValue()
        return MenuItem.default({label: "Move Effect", selectable: index > 0 || index < adapters.length - 1})
            .setRuntimeChildrenProcedure(parent => {
                    return parent.addMenuItem(
                        MenuItem.default({label: "Left", selectable: index > 0})
                            .setTriggerProcedure(() => editing.modify(() => {
                                adapter.indexField.setValue(index - 1)
                                adapters[index - 1].indexField.setValue(index)
                            })),
                        MenuItem.default({label: "Right", selectable: index < adapters.length - 1})
                            .setTriggerProcedure(() => editing.modify(() => {
                                adapter.indexField.setValue(index + 1)
                                adapters[index + 1].indexField.setValue(index)
                            }))
                    )
                }
            )
    }
}
