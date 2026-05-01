import {DeviceHost, Devices, EffectDeviceBoxAdapter, InstrumentFactories, PresetHeader} from "@opendaw/studio-adapters"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {IndexedBox, PrimitiveField, PrimitiveValues} from "@opendaw/lib-box"
import {Editing, isDefined, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
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
        parent.addMenuItem(MenuItem.default({
            label: `Delete '${audioUnit.label}'`,
            hidden: audioUnit.isOutput,
            separatorBefore: true
        }).setTriggerProcedure(() => editing.modify(() => project.api.deleteAudioUnit(audioUnit.box))))
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
            populateMenuItemToCreateEffect(service, host, device)
        )
        populatePresetSubmenu(parent, service, host, {kind: "effect-context", device})
        parent.addMenuItem(populateMenuItemToDeleteDevice(editing, device, {separatorBefore: true}))
    }

    const populateMenuItemToNavigateToManual = (path: string, name: string) => {
        return MenuItem.default({label: `Visit '${name}' Manual...`})
            .setTriggerProcedure(() => RouteLocation.get().navigateTo(path))
    }

    const populateMenuItemToDeleteDevice = (editing: Editing,
                                             device: EffectDeviceBoxAdapter,
                                             options?: {separatorBefore?: boolean}) => {
        const label = `Delete '${device.labelField.getValue()}'`
        return MenuItem.default({label, separatorBefore: options?.separatorBefore})
            .setTriggerProcedure(() => editing.modify(() => Devices.deleteEffectDevices([device])))
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

    const allEffectsInHost = (service: StudioService,
                              host: DeviceHost,
                              kind: LibraryEffectKind): ReadonlyArray<EffectDeviceBoxAdapter> => {
        const field = kind === "audio-effect" ? host.audioEffects.field() : host.midiEffects.field()
        return field.pointerHub.incoming()
            .map(({box}) => service.project.boxAdapters.adapterFor(box, Devices.isAny))
            .filter((adapter): adapter is EffectDeviceBoxAdapter =>
                adapter.type === "audio-effect" || adapter.type === "midi-effect")
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
    }

    const saveSingleOrChain = async (actions: LibraryActions,
                                     kind: LibraryEffectKind,
                                     chainKind: PresetHeader.ChainKind,
                                     kindLabel: string,
                                     effect: EffectDeviceBoxAdapter): Promise<void> => {
        const choice = await Promises.tryCatch(RuntimeNotifier.approve({
            headline: "Save as Effect Chain or Device Preset?",
            message: `Only one ${kindLabel} effect on this audio unit. `
                + `Save it as a single device preset or as an Effect Chain?`,
            approveText: "Effect Chain",
            cancelText: "Device Preset"
        }))
        if (choice.status === "rejected") {return}
        const effectBox = effect.box as IndexedBox
        if (choice.value) {
            await actions.saveAsChainPreset(chainKind, [effectBox])
        } else {
            const deviceKey = effect.box.name.replace(/DeviceBox$/, "")
            await actions.saveAsSingleEffectPreset(kind, deviceKey, effectBox)
        }
    }

    const populatePresetSubmenu = (parent: MenuItem,
                                   service: StudioService,
                                   host: DeviceHost,
                                   context: PresetContext): void => {
        const libraryActions = service.libraryActions
        const instrumentTarget = resolveInstrumentTarget(host)
        parent.addMenuItem(
            MenuItem.default({label: "Preset", separatorBefore: true})
                .setRuntimeChildrenProcedure(submenu => {
                    if (context.kind === "instrument-context" && isDefined(instrumentTarget)) {
                        const labeled = host.inputAdapter.mapOr(input => input.labelField.getValue(), "")
                        const deviceName = labeled.length > 0 ? labeled : instrumentTarget.key
                        submenu.addMenuItem(MenuItem.default({label: `Save '${deviceName}' as Preset`})
                            .setTriggerProcedure(() => libraryActions.saveAsInstrumentPreset(
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
                            .setTriggerProcedure(() => libraryActions.saveAsSingleEffectPreset(
                                effectKind, deviceKey, effectBox).catch(console.warn)))
                    }
                    if (isDefined(instrumentTarget)) {
                        submenu.addMenuItem(MenuItem.default({label: "Save Entire Audio-Unit Chain"})
                            .setTriggerProcedure(() => libraryActions.saveAsRackPreset(instrumentTarget.uuid, [])
                                .catch(console.warn)))
                    }
                    const chainKindCandidates: ReadonlyArray<LibraryEffectKind> = context.kind === "effect-context"
                        ? [context.device.type === "audio-effect" ? "audio-effect" : "midi-effect"]
                        : ["audio-effect", "midi-effect"]
                    for (const kind of chainKindCandidates) {
                        const chainKind = kind === "audio-effect" ? PresetHeader.ChainKind.Audio : PresetHeader.ChainKind.Midi
                        const kindLabel = kind === "audio-effect" ? "Audio" : "MIDI"
                        if (context.kind === "effect-context") {
                            const effects = sameKindEffectsInHost(service, host, kind)
                            const selectable = effects.length >= 2
                            const label = selectable
                                ? `Save ${kindLabel} Effect Chain (${effects.length})`
                                : `Save ${kindLabel} Effect Chain`
                            submenu.addMenuItem(MenuItem.default({label, selectable})
                                .setTriggerProcedure(() => libraryActions.saveAsChainPreset(
                                    chainKind, effects.map(adapter => adapter.box as IndexedBox))
                                    .catch(console.warn)))
                        } else {
                            const effects = allEffectsInHost(service, host, kind)
                            const selectable = effects.length >= 1
                            const label = effects.length >= 2
                                ? `Save ${kindLabel} Effect Chain (${effects.length})`
                                : `Save ${kindLabel} Effect Chain`
                            submenu.addMenuItem(MenuItem.default({label, selectable})
                                .setTriggerProcedure(() => {
                                    if (effects.length === 1) {
                                        saveSingleOrChain(libraryActions, kind, chainKind, kindLabel, effects[0])
                                            .catch(console.warn)
                                    } else {
                                        libraryActions.saveAsChainPreset(chainKind,
                                            effects.map(adapter => adapter.box as IndexedBox))
                                            .catch(console.warn)
                                    }
                                }))
                        }
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