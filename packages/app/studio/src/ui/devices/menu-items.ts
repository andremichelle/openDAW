import {DeviceHost, Devices, EffectDeviceBoxAdapter, InstrumentFactories, PresetHeader} from "@opendaw/studio-adapters"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {IndexedBox, PrimitiveField, PrimitiveValues, StringField} from "@opendaw/lib-box"
import {Editing, EmptyExec, isDefined, panic, UUID} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {StudioService} from "@/service/StudioService"
import {RouteLocation} from "@opendaw/lib-jsx"
import {LibraryActions, LibraryEffectKind} from "@/ui/browse/LibraryActions"

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
        populatePresetSubmenu(parent, service, deviceHost, {kind: "instrument-context"})
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
        populatePresetSubmenu(parent, service, host, {kind: "effect-context", device})
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

    type PresetContext =
        | {kind: "instrument-context"}
        | {kind: "effect-context", device: EffectDeviceBoxAdapter}

    const resolveInstrumentTarget = (host: DeviceHost): {key: InstrumentFactories.Keys, uuid: UUID.String} | null => {
        const inputBox = host.audioUnitBoxAdapter().box.input.pointerHub.incoming().at(0)?.box
        if (!isDefined(inputBox)) {return null}
        const stripped = inputBox.name.replace(/DeviceBox$/, "")
        if (!Object.hasOwn(InstrumentFactories.Named, stripped)) {return null}
        return {key: stripped as InstrumentFactories.Keys, uuid: UUID.toString(inputBox.address.uuid)}
    }

    const sameKindEffectsInHost = (service: StudioService,
                                   host: DeviceHost,
                                   kind: LibraryEffectKind): ReadonlyArray<EffectDeviceBoxAdapter> =>
        service.project.deviceSelection.selected()
            .filter((entry): entry is EffectDeviceBoxAdapter =>
                entry.type === kind && entry.deviceHost() === host)
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())

    const populatePresetSubmenu = (parent: MenuItem,
                                   service: StudioService,
                                   host: DeviceHost,
                                   context: PresetContext): void => {
        const actions = new LibraryActions(service.project)
        const instrumentTarget = resolveInstrumentTarget(host)
        parent.addMenuItem(
            MenuItem.default({label: "Preset", separatorBefore: true})
                .setRuntimeChildrenProcedure(submenu => {
                    if (context.kind === "instrument-context" && isDefined(instrumentTarget)) {
                        const labeled = host.inputAdapter.mapOr(input => input.labelField.getValue(), "")
                        const deviceName = labeled.length > 0 ? labeled : instrumentTarget.key
                        submenu.addMenuItem(MenuItem.default({label: `Save '${deviceName}' as Preset`})
                            .setTriggerProcedure(() => actions.saveAsInstrumentPreset(
                                instrumentTarget.key, instrumentTarget.uuid, {excludeEffects: true})
                                .catch(console.warn)))
                    } else if (context.kind === "effect-context") {
                        const effectKind: LibraryEffectKind = context.device.type === "audio-effect"
                            ? "audio-effect" : "midi-effect"
                        const deviceKey = context.device.box.name.replace(/DeviceBox$/, "")
                        const effectBox = context.device.box as IndexedBox
                        const labeled = context.device.labelField.getValue()
                        const deviceName = labeled.length > 0 ? labeled : deviceKey
                        submenu.addMenuItem(MenuItem.default({label: `Save '${deviceName}' as Preset`})
                            .setTriggerProcedure(() => actions.saveAsSingleEffectPreset(
                                effectKind, deviceKey, effectBox).catch(console.warn)))
                    }
                    if (isDefined(instrumentTarget)) {
                        submenu.addMenuItem(MenuItem.default({label: "Save Entire Audio-Unit Chain"})
                            .setTriggerProcedure(() => actions.saveAsRackPreset(instrumentTarget.uuid, [])
                                .catch(console.warn)))
                    }
                    const chainKindCandidates: ReadonlyArray<LibraryEffectKind> = context.kind === "effect-context"
                        ? [context.device.type === "audio-effect" ? "audio-effect" : "midi-effect"]
                        : ["audio-effect", "midi-effect"]
                    for (const kind of chainKindCandidates) {
                        const effects = sameKindEffectsInHost(service, host, kind)
                        const chainKind = kind === "audio-effect" ? PresetHeader.ChainKind.Audio : PresetHeader.ChainKind.Midi
                        const kindLabel = kind === "audio-effect" ? "Audio" : "MIDI"
                        const selectable = effects.length >= 2
                        const label = selectable
                            ? `Save ${kindLabel} Effect Chain (${effects.length})`
                            : `Save ${kindLabel} Effect Chain`
                        submenu.addMenuItem(MenuItem.default({label, selectable})
                            .setTriggerProcedure(() => actions.saveAsChainPreset(
                                chainKind, effects.map(adapter => adapter.box as IndexedBox))
                                .catch(console.warn)))
                    }
                })
        )
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