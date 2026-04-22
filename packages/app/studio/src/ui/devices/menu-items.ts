import {DeviceHost, Devices, EffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {PrimitiveField, PrimitiveValues, StringField} from "@opendaw/lib-box"
import {Editing, EmptyExec, panic} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {StudioService} from "@/service/StudioService"
import {RouteLocation} from "@opendaw/lib-jsx"

export namespace MenuItems {
    export const forAudioUnitInput = (parent: MenuItem, service: StudioService, deviceHost: DeviceHost): void => {
        const {project} = service
        const {editing, api} = project
        const audioUnit = deviceHost.audioUnitBoxAdapter()
        const {canProcessMidi, manualUrl, name} = deviceHost.inputAdapter.mapOr(input => ({
            canProcessMidi: input.type === "instrument",
            manualUrl: input.manualUrl,
            name: input.labelField.getValue()
        }), {canProcessMidi: false, manualUrl: "manuals", name: "Unknown"})
        parent.addMenuItem(
            populateMenuItemToNavigateToManual(manualUrl, name),
            MenuItem.default({
                label: `Delete '${audioUnit.label}'`,
                hidden: audioUnit.isOutput
            }).setTriggerProcedure(() => editing.modify(() => project.api.deleteAudioUnit(audioUnit.box))),
            populateMenuItemToRenameDevice(editing, audioUnit.inputAdapter.unwrap().labelField),
            MenuItem.default({label: "Add Midi-Effect", separatorBefore: true, selectable: canProcessMidi})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.MidiList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        icon: entry.defaultIcon,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(deviceHost.midiEffects.field(), entry, 0))))
                )),
            MenuItem.default({label: "Add Audio Effect"})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.AudioList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        icon: entry.defaultIcon,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(deviceHost.audioEffects.field(), entry, 0))))
                ))
        )
    }

    export const createForValue = <V extends PrimitiveValues>(editing: Editing,
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
            populateMenuItemToNavigateToManual(device.manualUrl, device.labelField.getValue()),
            populateMenuItemToDeleteDevice(editing, device),
            populateMenuItemToCreateEffect(service, host, device)
        )
    }

    const populateMenuItemToRenameDevice = (editing: Editing, labelField: StringField) =>
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

    const populateMenuItemToNavigateToManual = (path: string, name: string) => {
        return MenuItem.default({label: `Visit '${name}' Manual...`})
            .setTriggerProcedure(() => RouteLocation.get().navigateTo(path))
    }

    const populateMenuItemToDeleteDevice = (editing: Editing, ...devices: ReadonlyArray<EffectDeviceBoxAdapter>) => {
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
                            icon: factory.defaultIcon,
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
                                icon: factory.defaultIcon,
                                separatorBefore: factory.separatorBefore
                            }).setTriggerProcedure(() => editing.modify(() => api
                                .insertEffect(host.midiEffects.field(), factory, adapter.indexField.getValue() + 1))))
                        )) : panic(`Unknown accepts value: ${adapter.accepts}`)
    }
}