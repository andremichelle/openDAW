import {
    AudioUnitBoxAdapter,
    DeviceBoxAdapter,
    DeviceHost,
    Devices,
    EffectDeviceBoxAdapter,
    InstrumentCompositeBoxAdapter,
    InstrumentCompositeCellBoxAdapter,
    InstrumentFactories,
    PresetHeader
} from "@opendaw/studio-adapters"
import {
    AudioUnitAsLayer, AudioUnitsClipboard, ClipboardManager, DevicesClipboard, EffectFactories, MenuItem, NestedHostExit
} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"
import {IndexedBox, PrimitiveField, PrimitiveValues, Vertex} from "@opendaw/lib-box"
import {Editing, isDefined, isInstanceOf, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Clipboard} from "@opendaw/lib-dom"
import {InstrumentCompositeBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {openManual} from "@/ui/manuals"
import {effectKeyOf, PresetEffectKind, PresetService} from "@/ui/browse/PresetService"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

export namespace MenuItems {
    export const forAudioUnitInput = (parent: MenuItem, service: StudioService, deviceHost: DeviceHost): void => {
        const {project} = service
        const {editing, api} = project
        const audioUnit = deviceHost.audioUnitBoxAdapter()
        const {canProcessMidi, manualUrl, name} = deviceHost.inputAdapter.mapOr(input => ({
            canProcessMidi: input.accepts === "midi",
            manualUrl: input.manualUrl,
            name: input.labelField.getValue()
        }), {canProcessMidi: false, manualUrl: "manuals", name: "Unknown"})
        // A one-sided host takes only one chain kind, so each "Add ..." is hidden unless the host has that chain.
        const optMidiField = deviceHost.midiEffectsField
        const optAudioField = deviceHost.audioEffectsField
        parent.addMenuItem(
            populateMenuItemToNavigateToManual(manualUrl, name),
            MenuItem.default({
                label: "Add Midi-Effect",
                separatorBefore: true,
                hidden: !canProcessMidi || optMidiField.isEmpty()
            })
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.MidiList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        icon: entry.defaultIcon,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(optMidiField.unwrap("midiEffectsField"), entry, 0))))
                )),
            MenuItem.default({label: "Add Audio Effect", hidden: optAudioField.isEmpty()})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.AudioList
                    .map(entry => MenuItem.default({
                        label: entry.defaultName,
                        icon: entry.defaultIcon,
                        separatorBefore: entry.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(optAudioField.unwrap("audioEffectsField"), entry, 0))))
                ))
        )
        if (deviceHost instanceof InstrumentCompositeCellBoxAdapter) {
            populatePresetSubmenu(parent, service, deviceHost, {kind: "instrument-context"})
            parent.addMenuItem(copyAudioUnit(audioUnit, {separatorBefore: true}))
            parent.addMenuItem(MenuItem.default({label: "Duplicate layer", separatorBefore: true})
                .setTriggerProcedure(() => editing.modify(() => {
                    project.userEditingManager.audioUnit.edit(api.duplicateCompositeLayer(deviceHost.box))
                })))
            parent.addMenuItem(MenuItem.default({label: "Delete layer"})
                .setTriggerProcedure(() => editing.modify(() => {
                    project.userEditingManager.audioUnit.edit(backTargetOfCell(deviceHost))
                    api.deleteCompositeLayer(deviceHost.box)
                })))
            return
        }
        populatePresetSubmenu(parent, service, deviceHost, {kind: "instrument-context"})
        parent.addMenuItem(copyAudioUnit(audioUnit, {separatorBefore: true}))
        deviceHost.inputAdapter.ifSome(input => {
            if (isInstanceOf(input.box, InstrumentCompositeBox)) {parent.addMenuItem(pasteAudioUnitAsLayer(service, input.box))}
        })
        parent.addMenuItem(MenuItem.default({
            label: `Delete '${audioUnit.label}'`,
            hidden: audioUnit.isOutput,
            separatorBefore: true
        }).setTriggerProcedure(() => editing.modify(() => project.api.deleteAudioUnit(audioUnit.box))))
    }

    export const copyAudioUnit = (audioUnit: AudioUnitBoxAdapter, options?: { separatorBefore?: boolean }): MenuItem =>
        MenuItem.default({label: "Copy AudioUnit", hidden: audioUnit.isOutput, separatorBefore: options?.separatorBefore})
            .setTriggerProcedure(() => AudioUnitsClipboard.copyEntry(audioUnit).ifSome(ClipboardManager.write))

    // the system clipboard is async, so the item is enabled by this session's last copy and reads the system
    // clipboard first when triggered
    export const pasteAudioUnitAsLayer = (service: StudioService, composite: InstrumentCompositeBox): MenuItem =>
        MenuItem.default({
            label: "Paste AudioUnit as Layer",
            selectable: ClipboardManager.peek().mapOr(entry => entry.type === "audio-units", false)
        }).setTriggerProcedure(async () => {
            const {editing, api, userEditingManager} = service.project
            const system = (await Option.async(Clipboard.readText())).flatMap(ClipboardManager.decode)
            const entry = system.nonEmpty() ? system : ClipboardManager.peek()
            if (entry.mapOr(entry => entry.type !== "audio-units", true) || !composite.isAttached()) {return}
            const {data} = entry.unwrap()
            const targetUnit = service.project.boxAdapters.adapterFor(composite, InstrumentCompositeBoxAdapter).audioUnitBoxAdapter().box
            const notes: Option<AudioUnitAsLayer.Notes> = AudioUnitAsLayer.clipboardHasNotes(data) && AudioUnitAsLayer.hasNotes(targetUnit)
                ? await Dialogs.choose<AudioUnitAsLayer.Notes>({
                    headline: "Both have notes",
                    message: "The copied audio unit and this track both hold notes. What should happen to the copied notes?",
                    choices: [
                        {text: "Drop copied notes", value: "keep"},
                        {text: "Replace existing notes", value: "replace"},
                        {text: "Append", value: "append"}
                    ]
                })
                : Option.wrap("append")
            if (notes.isEmpty() || !composite.isAttached()) {return}
            const attempt = editing.modify(() => api.pasteAudioUnitAsLayer(composite, data, notes.unwrap())).unwrap()
            if (attempt.isFailure()) {
                RuntimeNotifier.notify({message: attempt.failureReason(), icon: "Warning"})
            } else {
                userEditingManager.audioUnit.edit(attempt.result().cellBox)
            }
        })

    export const backTargetOfCell = (cell: DeviceHost): Vertex<Pointers> => NestedHostExit.targetsOf(cell)[0]

    export const createForValue = <V extends PrimitiveValues>(editing: Editing,
                                                              label: string,
                                                              primitive: PrimitiveField<V, any>,
                                                              value: V) =>
        MenuItem.default({label, checked: primitive.getValue() === value})
            .setTriggerProcedure(() => editing.modify(() => primitive.setValue(value)))

    export const forCompositeCell = (parent: MenuItem,
                                     service: StudioService,
                                     host: DeviceHost,
                                     composite: DeviceBoxAdapter): void => {
        const {editing, api} = service.project
        const optMidiField = host.midiEffectsField
        const optAudioField = host.audioEffectsField
        parent.addMenuItem(
            populateMenuItemToNavigateToManual(composite.manualUrl, composite.labelField.getValue()),
            MenuItem.default({
                label: "Add Midi-Effect",
                separatorBefore: true,
                hidden: !DeviceHost.takesEffect(host, "midi")
            }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.MidiList
                .map(entry => MenuItem.default({
                    label: entry.defaultName,
                    icon: entry.defaultIcon,
                    separatorBefore: entry.separatorBefore
                }).setTriggerProcedure(() => editing.modify(() =>
                    api.insertEffect(optMidiField.unwrap("midiEffectsField"), entry, 0))))
            )),
            MenuItem.default({
                label: "Add Audio Effect",
                separatorBefore: optMidiField.isEmpty(),
                hidden: optAudioField.isEmpty()
            }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(...EffectFactories.AudioList
                .map(entry => MenuItem.default({
                    label: entry.defaultName,
                    icon: entry.defaultIcon,
                    separatorBefore: entry.separatorBefore
                }).setTriggerProcedure(() => editing.modify(() =>
                    api.insertEffect(optAudioField.unwrap("audioEffectsField"), entry, 0))))
            )),
            copyAudioUnit(host.audioUnitBoxAdapter(), {separatorBefore: true})
        )
    }

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
        parent.addMenuItem(
            copyAudioUnit(host.audioUnitBoxAdapter(), {separatorBefore: true}),
            populateMenuItemToDuplicateDevice(service, host, device),
            populateMenuItemToDeleteDevice(editing, device)
        )
    }

    const populateMenuItemToDuplicateDevice = (service: StudioService,
                                               host: DeviceHost,
                                               device: EffectDeviceBoxAdapter,
                                               options?: { separatorBefore?: boolean }) => {
        const {editing, deviceSelection, boxGraph, boxAdapters} = service.project
        return MenuItem.default({
            label: `Duplicate '${device.labelField.getValue()}'`,
            shortcut: GlobalShortcuts["copy-device"].shortcut.format(),
            separatorBefore: options?.separatorBefore
        }).setTriggerProcedure(() => {
            if (!deviceSelection.isSelected(device)) {
                deviceSelection.deselectAll()
                deviceSelection.select(device)
            }
            DevicesClipboard.duplicate({
                getEnabled: () => true,
                editing,
                selection: deviceSelection,
                boxGraph,
                boxAdapters,
                getHost: () => Option.wrap(host)
            })
        })
    }

    const populateMenuItemToNavigateToManual = (path: string, name: string) => {
        return MenuItem.default({label: `Visit '${name}' Manual...`})
            .setTriggerProcedure(() => openManual(path))
    }

    const populateMenuItemToDeleteDevice = (editing: Editing,
                                            device: EffectDeviceBoxAdapter,
                                            options?: { separatorBefore?: boolean }) => {
        const label = `Delete '${device.labelField.getValue()}'`
        return MenuItem.default({label, separatorBefore: options?.separatorBefore})
            .setTriggerProcedure(() => editing.modify(() => Devices.deleteEffectDevices([device])))
    }

    type PresetContext =
        | { kind: "instrument-context" }
        | { kind: "effect-context", device: EffectDeviceBoxAdapter }

    const resolveInstrumentTarget = (host: DeviceHost): { key: InstrumentFactories.Keys, uuid: UUID.String } | null => {
        const inputBox = host.hostsInstrument
            ? host.inputAdapter.map(adapter => adapter.box).unwrapOrUndefined()
            : host.audioUnitBoxAdapter().box.input.pointerHub.incoming().at(0)?.box
        if (!isDefined(inputBox)) {return null}
        const key = InstrumentFactories.keyOfBox(inputBox)
        return isDefined(key) ? {key, uuid: UUID.toString(inputBox.address.uuid)} : null
    }

    const sameKindEffectsInHost = (service: StudioService,
                                   host: DeviceHost,
                                   kind: PresetEffectKind): ReadonlyArray<EffectDeviceBoxAdapter> =>
        service.project.deviceSelection.selected()
            .filter((entry): entry is EffectDeviceBoxAdapter =>
                entry.type === kind && entry.deviceHost() === host)
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())

    // A host that takes no chain of `kind` (a one-sided composite entry) holds no such effects.
    const allEffectsInHost = (service: StudioService,
                              host: DeviceHost,
                              kind: PresetEffectKind): ReadonlyArray<EffectDeviceBoxAdapter> =>
        DeviceHost.chainFieldOf(host, kind === "audio-effect" ? "audio" : "midi")
            .mapOr(field => field.pointerHub.incoming()
                .map(({box}) => service.project.boxAdapters.adapterFor(box, Devices.isAny))
                .filter((adapter): adapter is EffectDeviceBoxAdapter =>
                    adapter.type === "audio-effect" || adapter.type === "midi-effect")
                .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue()), [])

    const saveSingleOrChain = async (actions: PresetService,
                                     kind: PresetEffectKind,
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
            await actions.saveAsSingleEffectPreset(kind, effectKeyOf(effectBox), effectBox)
        }
    }

    const populatePresetSubmenu = (parent: MenuItem,
                                   service: StudioService,
                                   host: DeviceHost,
                                   context: PresetContext): void => {
        const presets = service.presets
        const instrumentTarget = resolveInstrumentTarget(host)
        parent.addMenuItem(
            MenuItem.default({label: "Preset", separatorBefore: true})
                .setRuntimeChildrenProcedure(submenu => {
                    if (context.kind === "instrument-context" && isDefined(instrumentTarget)) {
                        const labeled = host.inputAdapter.mapOr(input => input.labelField.getValue(), "")
                        const deviceName = labeled.length > 0 ? labeled : instrumentTarget.key
                        submenu.addMenuItem(MenuItem.default({label: `Save '${deviceName}' as Preset`})
                            .setTriggerProcedure(() => presets.saveAsInstrumentPreset(
                                instrumentTarget.key, instrumentTarget.uuid, {excludeEffects: true})
                                .catch(console.warn)))
                    } else if (context.kind === "effect-context") {
                        const effectKind: PresetEffectKind = context.device.type === "audio-effect"
                            ? "audio-effect" : "midi-effect"
                        const effectBox = context.device.box as IndexedBox
                        const deviceKey = effectKeyOf(effectBox)
                        const labeled = context.device.labelField.getValue()
                        const deviceName = labeled.length > 0 ? labeled : deviceKey
                        submenu.addMenuItem(MenuItem.default({label: `Save '${deviceName}' as Preset`})
                            .setTriggerProcedure(() => presets.saveAsSingleEffectPreset(
                                effectKind, deviceKey, effectBox).catch(console.warn)))
                    }
                    if (isDefined(instrumentTarget) && !(host instanceof InstrumentCompositeCellBoxAdapter)) {
                        submenu.addMenuItem(MenuItem.default({label: "Save Entire Audio-Unit Chain"})
                            .setTriggerProcedure(() => presets.saveAsRackPreset(instrumentTarget.uuid, [])
                                .catch(console.warn)))
                    }
                    const chainKindCandidates: ReadonlyArray<PresetEffectKind> = context.kind === "effect-context"
                        ? [context.device.type === "audio-effect" ? "audio-effect" : "midi-effect"]
                        : ["audio-effect", "midi-effect"]
                    for (const kind of chainKindCandidates) {
                        const chainKind = kind === "audio-effect"
                            ? PresetHeader.ChainKind.Audio
                            : PresetHeader.ChainKind.Midi
                        const kindLabel = kind === "audio-effect" ? "Audio" : "MIDI"
                        if (context.kind === "effect-context") {
                            const effects = sameKindEffectsInHost(service, host, kind)
                            const selectable = effects.length >= 2
                            const label = selectable
                                ? `Save ${kindLabel} Effect Chain (${effects.length})`
                                : `Save ${kindLabel} Effect Chain`
                            submenu.addMenuItem(MenuItem.default({label, selectable})
                                .setTriggerProcedure(() => presets.saveAsChainPreset(
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
                                        saveSingleOrChain(presets, kind, chainKind, kindLabel, effects[0])
                                            .catch(console.warn)
                                    } else {
                                        presets.saveAsChainPreset(chainKind,
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
        // `adapter` already sits in this host's chain of its own kind, so that chain field is present.
        const field = DeviceHost.chainFieldOf(host, adapter.accepts).unwrap(`host takes no ${adapter.accepts} effects`)
        const isAudio = adapter.accepts === "audio"
        return MenuItem.default({label: isAudio ? "Add Audio Effect" : "Add Midi Effect", separatorBefore: true})
            .setRuntimeChildrenProcedure(parent => parent
                .addMenuItem(...(isAudio ? EffectFactories.AudioList : EffectFactories.MidiList)
                    .map(factory => MenuItem.default({
                        label: factory.defaultName,
                        icon: factory.defaultIcon,
                        separatorBefore: factory.separatorBefore
                    }).setTriggerProcedure(() => editing.modify(() =>
                        api.insertEffect(field, factory, adapter.indexField.getValue() + 1))))
                ))
    }
}