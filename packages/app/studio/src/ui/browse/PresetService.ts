import {
    DefaultObservableValue,
    Errors,
    isAbsent,
    isDefined,
    isNull,
    Lifecycle,
    Nullable,
    ObservableValue,
    Option,
    panic,
    RuntimeNotifier,
    Strings,
    UUID
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {DeviceBoxAdapter, DeviceBoxUtils, Devices, EffectDeviceBoxAdapter, InstrumentFactories, PresetDecoder, PresetEncoder, PresetHeader} from "@opendaw/studio-adapters"
import {
    AudioEffectChainPresetMeta,
    AudioEffectPresetMeta,
    EffectFactories,
    FilePickerAcceptTypes,
    InstrumentPresetMeta,
    MidiEffectChainPresetMeta,
    MidiEffectPresetMeta,
    OpenPresetAPI,
    PresetBundle,
    PresetCategory,
    PresetEntry,
    PresetMeta,
    PresetStorage,
    Project,
    RackPresetMeta
} from "@opendaw/studio-core"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import {AnyDragData} from "@/ui/AnyDragData"
import {PresetDialogs} from "@/ui/browse/PresetDialogs"
import {PresetApplication} from "@/ui/browse/PresetApplication"
import type {StudioService} from "@/service/StudioService"

export type PresetCategoryKey = "instrument" | "audio-effect" | "midi-effect"
export type PresetEffectKind = "audio-effect" | "midi-effect"

// Returns the device key a preset entry resolves to in the per-device pager
// (e.g. "Vaporisateur", "Delay"). Chain presets carry no device key.
export const deviceKeyOf = (entry: PresetMeta): string => {
    switch (entry.category) {
        case "instrument":
        case "audio-effect":
        case "midi-effect":
            return entry.device
        case "audio-unit":
            return entry.instrument
        case "audio-effect-chain":
        case "midi-effect-chain":
            return ""
    }
}

// Per-device pager cursor key. Keyed by audio-unit UUID + device-slot rather
// than the device-box UUID so the cursor survives in-place replacement
// (replaceAudioUnit / delete + insertEffectChain assign new box UUIDs but
// keep the same slot).
const cursorKeyFor = (adapter: DeviceBoxAdapter): string => {
    const audioUnit = adapter.deviceHost().audioUnitBoxAdapter().box
    const auKey = UUID.toString(audioUnit.address.uuid)
    if (Devices.isEffect(adapter)) {
        return `${auKey}:${adapter.type}:${adapter.indexField.getValue()}`
    }
    return `${auKey}:${adapter.type}`
}

// Pager identity for an entry. UUID alone isn't unique — a user-saved preset
// can share its UUID with the stock one it was downloaded from. Disambiguating
// by source ensures findIndex lands on the actual entry we just applied.
type PresetIdentity = string
const identityOf = (entry: PresetEntry): PresetIdentity => `${entry.source}:${entry.uuid}`

export class PresetService {
    readonly #cloudIndex = new DefaultObservableValue<ReadonlyArray<PresetMeta>>([])
    readonly #cloudReady: Promise<void>
    readonly #cursors = new Map<string, PresetIdentity>()

    constructor(readonly service: StudioService) {
        PresetStorage.readIndex().catch(reason => console.warn("PresetStorage.readIndex failed", reason))
        this.#cloudReady = OpenPresetAPI.get().list().then(
            value => {this.#cloudIndex.setValue(value)},
            reason => {console.warn("OpenPresetAPI.list failed", reason)})
    }

    get project(): Project {return this.service.project}

    // Live observable of cloud presets (populated once OpenPresetAPI.list resolves).
    get cloudIndex(): ObservableValue<ReadonlyArray<PresetMeta>> {return this.#cloudIndex}

    // Live observable of user presets (delegates to PresetStorage's singleton).
    get userIndex(): ObservableValue<ReadonlyArray<PresetMeta>> {return PresetStorage.observable()}

    // Resolves once the cloud index has been fetched (or rejected).
    get cloudReady(): Promise<void> {return this.#cloudReady}

    // Merged user + cloud snapshot tagged with source.
    presets(): ReadonlyArray<PresetEntry> {
        const user = this.userIndex.getValue().map(meta => ({...meta, source: "user"} as PresetEntry))
        const cloud = this.#cloudIndex.getValue().map(meta => ({...meta, source: "stock"} as PresetEntry))
        return [...user, ...cloud]
    }

    // Presets matching a single device (category + device key), ordered for a stable pager.
    // The per-device pager is strictly same-category: an instrument adapter
    // walks instrument presets only, an effect adapter its own effect presets.
    // Rack (audio-unit) presets and chain presets are out of scope here —
    // applying one would replace the entire audio unit / chain, not just the
    // currently-paged device.
    presetsFor(category: PresetCategory, deviceKey: string): ReadonlyArray<PresetEntry> {
        return this.presets()
            .filter(entry => entry.category === category && deviceKeyOf(entry) === deviceKey)
            .toSorted((a, b) => {
                if (a.source !== b.source) {return a.source === "user" ? -1 : 1}
                return a.name.localeCompare(b.name)
            })
    }

    hasPresetsFor(category: PresetCategory, deviceKey: string): boolean {
        return this.presets().some(entry => entry.category === category && deviceKeyOf(entry) === deviceKey)
    }

    // Boolean signal for "does this device currently have any matching presets?".
    // Recomputes when either the user or cloud index changes; subscriptions are
    // bound to the supplied lifecycle.
    observePresetAvailability(category: PresetCategory,
                              deviceKey: string,
                              lifecycle: Lifecycle): ObservableValue<boolean> {
        const signal = new DefaultObservableValue(this.hasPresetsFor(category, deviceKey))
        const update = () => signal.setValue(this.hasPresetsFor(category, deviceKey))
        lifecycle.ownAll(
            this.userIndex.subscribe(update),
            this.#cloudIndex.subscribe(update)
        )
        return signal
    }

    // Pager helpers. Wrap around at the ends so repeated clicks cycle the list.
    nextPresetFor(category: PresetCategory,
                  deviceKey: string,
                  current: Option<PresetIdentity>): Option<PresetEntry> {
        return this.#stepPreset(category, deviceKey, current, +1)
    }

    prevPresetFor(category: PresetCategory,
                  deviceKey: string,
                  current: Option<PresetIdentity>): Option<PresetEntry> {
        return this.#stepPreset(category, deviceKey, current, -1)
    }

    // Per-device pager cursor. Keyed by slot, not box UUID, so it survives
    // in-place replacement. Value is `${source}:${uuid}` so a user preset and
    // a stock preset that happen to share a UUID are tracked separately.
    cursorFor(adapter: DeviceBoxAdapter): Option<PresetIdentity> {
        const value = this.#cursors.get(cursorKeyFor(adapter))
        return isDefined(value) ? Option.wrap(value) : Option.None
    }

    setCursor(adapter: DeviceBoxAdapter, entry: PresetEntry): void {
        this.#cursors.set(cursorKeyFor(adapter), identityOf(entry))
    }

    // Apply a preset to a specific device — replaces in place and updates the
    // cursor so subsequent next/prev clicks step from the newly-applied entry.
    // For "instrument" entries, keeps existing effects + timeline; for
    // "audio-unit" rack entries, replaces the whole audio unit. For effect
    // entries, deletes the target effect and inserts the preset at the same
    // index. Other categories are no-ops here (they never reach the pager).
    async applyPresetTo(adapter: DeviceBoxAdapter, entry: PresetEntry): Promise<void> {
        const loaded = await Promises.tryCatch(PresetApplication.loadBytes(entry.uuid, entry.source))
        if (loaded.status === "rejected") {
            // User cancelled the download — silent, no error popup.
            if (Errors.isAbort(loaded.error)) {return}
            console.warn(loaded.error)
            RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            return
        }
        const bytes = loaded.value
        const audioUnitBox = adapter.deviceHost().audioUnitBoxAdapter().box
        const cursorKey = cursorKeyFor(adapter)
        if (entry.category === "instrument") {
            this.project.editing.modify(() => {
                const attempt = PresetDecoder.replaceAudioUnit(bytes, audioUnitBox, {
                    keepMIDIEffects: true,
                    keepAudioEffects: true,
                    keepTimeline: true
                })
                if (attempt.isFailure()) {
                    RuntimeNotifier.notify({message: "Cannot apply preset.", icon: "Warning"})
                }
            })
            this.project.loadScriptDevices()
        } else if (entry.category === "audio-unit") {
            this.project.editing.modify(() => {
                const attempt = PresetDecoder.replaceAudioUnit(bytes, audioUnitBox)
                if (attempt.isFailure()) {
                    RuntimeNotifier.notify({message: "Cannot apply preset.", icon: "Warning"})
                }
            })
            this.project.loadScriptDevices()
        } else if (entry.category === "audio-effect" || entry.category === "midi-effect") {
            if (!Devices.isEffect(adapter)) {return}
            const effect = adapter as EffectDeviceBoxAdapter
            const insertIndex = effect.indexField.getValue()
            const chainKind = entry.category === "midi-effect"
                ? PresetHeader.ChainKind.Midi
                : PresetHeader.ChainKind.Audio
            this.project.editing.modify(() => {
                Devices.deleteEffectDevices([effect])
                const attempt = PresetDecoder.insertEffectChain(bytes, audioUnitBox, insertIndex, chainKind)
                if (attempt.isFailure()) {
                    RuntimeNotifier.notify({message: "Cannot apply preset.", icon: "Warning"})
                }
            })
            this.project.loadScriptDevices()
        } else {
            return
        }
        this.#cursors.set(cursorKey, identityOf(entry))
    }

    #stepPreset(category: PresetCategory,
                deviceKey: string,
                current: Option<PresetIdentity>,
                delta: -1 | 1): Option<PresetEntry> {
        const list = this.presetsFor(category, deviceKey)
        if (list.length === 0) {return Option.None}
        const currentIndex = current.match({
            none: () => -1,
            some: identity => list.findIndex(entry => identityOf(entry) === identity)
        })
        // No cursor (or stale): both directions land on the first entry, so the
        // user ends up in a known position. From there the next press wraps —
        // prev → last, next → second — symmetric and predictable.
        if (currentIndex < 0) {return Option.wrap(list[0])}
        const next = (currentIndex + delta + list.length) % list.length
        return Option.wrap(list[next])
    }

    createInstrument(key: InstrumentFactories.Keys): void {
        const factory = InstrumentFactories.Named[key]
        this.project.editing.modify(() => DefaultInstrumentFactory.create(this.project.api, factory))
    }

    createEffect(kind: PresetEffectKind, key: string): void {
        const factory = EffectFactories.MergedNamed[key as keyof typeof EffectFactories.MergedNamed]
        const audioUnitOption = this.project.userEditingManager.audioUnit.get()
        if (audioUnitOption.isEmpty()) {
            RuntimeNotifier.notify({
                message: "Create an instrument or select an audio-bus first.",
                icon: "Info"
            })
            return
        }
        audioUnitOption.ifSome(vertex => {
            const deviceHost = this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost)
            if (kind === "midi-effect" && deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                RuntimeNotifier.notify({
                    message: "The selected audio unit does not have a midi input.",
                    icon: "Info"
                })
                return
            }
            const field = kind === "audio-effect"
                ? deviceHost.audioEffects.field()
                : kind === "midi-effect"
                    ? deviceHost.midiEffects.field()
                    : panic(`Unknown ${kind}`)
            this.project.editing.modify(() => factory.create(this.project, field, field.pointerHub.incoming().length))
        })
    }

    createDevice(category: PresetCategoryKey, deviceKey: string): void {
        if (category === "instrument") {
            this.createInstrument(deviceKey as InstrumentFactories.Keys)
        } else {
            this.createEffect(category, deviceKey)
        }
    }

    resolveEffectBoxesFromDrag(kind: PresetEffectKind, dragData: AnyDragData): ReadonlyArray<IndexedBox> {
        if (dragData.type !== kind) {return []}
        if (isNull(dragData.uuids)) {return []}
        return dragData.uuids
            .map(uuidStr => this.project.boxGraph.findBox(UUID.parse(uuidStr)).unwrapOrNull())
            .filter((box): box is Box => isDefined(box))
            .filter(IndexedBox.isIndexedBox)
            .toSorted((a, b) => a.index.getValue() - b.index.getValue())
    }

    resolveDraggedInstrumentKey(dragData: AnyDragData): Nullable<InstrumentFactories.Keys> {
        if (dragData.type !== "instrument" || dragData.device !== null) {return null}
        const boxOpt = this.project.boxGraph.findBox(UUID.parse(dragData.uuid))
        if (boxOpt.isEmpty()) {return null}
        const stripped = boxOpt.unwrap().name.replace(/DeviceBox$/, "")
        return Object.hasOwn(InstrumentFactories.Named, stripped)
            ? stripped as InstrumentFactories.Keys
            : null
    }

    #effectKeyFromBox(box: IndexedBox): string {return box.name.replace(/DeviceBox$/, "")}

    #effectLabelFromBox(box: IndexedBox): string {
        const adapter = this.project.boxAdapters.adapterFor(box, Devices.isAny)
        const value = adapter.labelField.getValue()
        return value.length > 0 ? value : this.#effectKeyFromBox(box)
    }

    async saveAsSingleEffectPreset(category: PresetEffectKind,
                                   deviceKey: string,
                                   effect: IndexedBox): Promise<void> {
        const dialog = await Promises.tryCatch(PresetDialogs.showSavePresetDialog({
            headline: `Save ${deviceKey} Preset`,
            suggestedName: this.#effectLabelFromBox(effect),
            suggestedDescription: "",
            showTimelineToggle: false
        }))
        if (dialog.status === "rejected") {
            if (Errors.isAbort(dialog.error)) {return}
            throw dialog.error
        }
        const kind = category === "audio-effect" ? PresetHeader.ChainKind.Audio : PresetHeader.ChainKind.Midi
        const bytes = PresetEncoder.encodeEffects([effect], kind)
        const now = Date.now()
        const meta = category === "audio-effect"
            ? {
                category: "audio-effect",
                uuid: UUID.toString(UUID.generate()),
                name: dialog.value.name,
                device: deviceKey as EffectFactories.AudioEffectKeys,
                description: dialog.value.description,
                created: now,
                modified: now
            } satisfies AudioEffectPresetMeta
            : {
                category: "midi-effect",
                uuid: UUID.toString(UUID.generate()),
                name: dialog.value.name,
                device: deviceKey as EffectFactories.MidiEffectKeys,
                description: dialog.value.description,
                created: now,
                modified: now
            } satisfies MidiEffectPresetMeta
        await PresetStorage.save(meta, bytes)
    }

    async saveAsChainPreset(kind: PresetHeader.ChainKind, effects: ReadonlyArray<IndexedBox>): Promise<void> {
        const isAudio = kind === PresetHeader.ChainKind.Audio
        const defaultName = effects.length === 1
            ? this.#effectLabelFromBox(effects[0])
            : `${this.#effectLabelFromBox(effects[0])} chain`
        const dialog = await Promises.tryCatch(PresetDialogs.showSavePresetDialog({
            headline: isAudio ? "Save Audio Effect Chain" : "Save MIDI Effect Chain",
            suggestedName: defaultName,
            suggestedDescription: "",
            showTimelineToggle: false
        }))
        if (dialog.status === "rejected") {
            if (Errors.isAbort(dialog.error)) {return}
            throw dialog.error
        }
        const bytes = PresetEncoder.encodeEffects(effects, kind)
        const now = Date.now()
        const meta = isAudio
            ? {
                category: "audio-effect-chain",
                uuid: UUID.toString(UUID.generate()),
                name: dialog.value.name,
                description: dialog.value.description,
                created: now,
                modified: now
            } satisfies AudioEffectChainPresetMeta
            : {
                category: "midi-effect-chain",
                uuid: UUID.toString(UUID.generate()),
                name: dialog.value.name,
                description: dialog.value.description,
                created: now,
                modified: now
            } satisfies MidiEffectChainPresetMeta
        await PresetStorage.save(meta, bytes)
    }

    async saveAsInstrumentPreset(deviceKey: InstrumentFactories.Keys,
                                 sourceUuid: UUID.String,
                                 options?: {excludeEffects?: boolean}): Promise<void> {
        const audioUnitBox = this.#audioUnitBoxForInstrumentUuid(sourceUuid)
        if (isAbsent(audioUnitBox)) {return}
        const inputBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
        if (isAbsent(inputBox)) {return}
        const adapter = this.project.boxAdapters.adapterFor(inputBox, Devices.isAny)
        const labeled = adapter.labelField.getValue()
        const suggestedName = labeled.length > 0 ? labeled : deviceKey
        const dialog = await Promises.tryCatch(PresetDialogs.showSavePresetDialog({
            headline: `Save ${deviceKey} Preset`,
            suggestedName,
            suggestedDescription: ""
        }))
        if (dialog.status === "rejected") {
            if (Errors.isAbort(dialog.error)) {return}
            throw dialog.error
        }
        const now = Date.now()
        const meta: InstrumentPresetMeta = {
            category: "instrument",
            uuid: UUID.toString(UUID.generate()),
            name: dialog.value.name,
            device: deviceKey,
            description: dialog.value.description,
            created: now,
            modified: now,
            hasTimeline: dialog.value.includeTimeline
        }
        const encodeOptions: Parameters<typeof PresetEncoder.encode>[1] =
            options?.excludeEffects === true
                ? {includeTimeline: dialog.value.includeTimeline, excludeEffect: DeviceBoxUtils.isEffectDeviceBox}
                : {includeTimeline: dialog.value.includeTimeline}
        await PresetStorage.save(meta, PresetEncoder.encode(audioUnitBox, encodeOptions))
    }

    async handleRackDrop(instrumentUuid: UUID.String,
                         effectUuids: ReadonlyArray<UUID.String>): Promise<void> {
        if (effectUuids.length > 0) {
            await this.saveAsRackPreset(instrumentUuid, effectUuids)
            return
        }
        const choice = await Promises.tryCatch(PresetDialogs.showRackCompositionDialog(
            "Save as Rack",
            "Include the entire audio chain, or save just the instrument?"))
        if (choice.status === "rejected") {
            if (Errors.isAbort(choice.error)) {return}
            throw choice.error
        }
        if (choice.value.choice === "entire-chain") {
            await this.saveAsRackPreset(instrumentUuid, [])
            return
        }
        const instrumentKey = this.#instrumentKeyForUuid(instrumentUuid)
        if (isAbsent(instrumentKey)) {return}
        await this.saveAsInstrumentPreset(instrumentKey, instrumentUuid)
    }

    #instrumentKeyForUuid(uuid: UUID.String): Nullable<InstrumentFactories.Keys> {
        const boxOpt = this.project.boxGraph.findBox(UUID.parse(uuid))
        if (boxOpt.isEmpty()) {return null}
        const stripped = boxOpt.unwrap().name.replace(/DeviceBox$/, "")
        return Object.hasOwn(InstrumentFactories.Named, stripped)
            ? stripped as InstrumentFactories.Keys : null
    }

    async saveAsRackPreset(instrumentUuid: UUID.String,
                           effectUuids: ReadonlyArray<UUID.String>): Promise<void> {
        const audioUnitBox = this.#audioUnitBoxForInstrumentUuid(instrumentUuid)
        if (isAbsent(audioUnitBox)) {return}
        const inputBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
        if (isAbsent(inputBox)) {return}
        const stripped = inputBox.name.replace(/DeviceBox$/, "")
        if (!Object.hasOwn(InstrumentFactories.Named, stripped)) {return}
        const instrument = stripped as InstrumentFactories.Keys
        const adapter = this.project.boxAdapters.adapterFor(inputBox, Devices.isAny)
        const labeled = adapter.labelField.getValue()
        const suggestedName = labeled.length > 0 ? labeled : instrument
        const dialog = await Promises.tryCatch(PresetDialogs.showSavePresetDialog({
            headline: "Save as Rack",
            suggestedName,
            suggestedDescription: ""
        }))
        if (dialog.status === "rejected") {
            if (Errors.isAbort(dialog.error)) {return}
            throw dialog.error
        }
        const now = Date.now()
        const includeTimeline = dialog.value.includeTimeline
        const meta: RackPresetMeta = {
            category: "audio-unit",
            uuid: UUID.toString(UUID.generate()),
            name: dialog.value.name,
            instrument,
            description: dialog.value.description,
            created: now,
            modified: now,
            hasTimeline: includeTimeline
        }
        const keep = new Set(effectUuids)
        const bytes = effectUuids.length === 0
            ? PresetEncoder.encode(audioUnitBox, {includeTimeline})
            : PresetEncoder.encode(audioUnitBox, {
                includeTimeline,
                excludeEffect: (box: Box) =>
                    DeviceBoxUtils.isEffectDeviceBox(box) && !keep.has(UUID.toString(box.address.uuid))
            })
        await PresetStorage.save(meta, bytes)
    }

    resolveRackCandidate(dragData: AnyDragData): Nullable<{
        instrumentKey: InstrumentFactories.Keys
        instrumentUuid: UUID.String
        effectUuids: ReadonlyArray<UUID.String>
    }> {
        if (dragData.type === "instrument" && dragData.device === null) {
            const key = this.#instrumentKeyForUuid(dragData.uuid)
            if (isAbsent(key)) {return null}
            return {instrumentKey: key, instrumentUuid: dragData.uuid, effectUuids: dragData.effects}
        }
        if ((dragData.type === "audio-effect" || dragData.type === "midi-effect")
            && dragData.uuids !== null
            && isDefined(dragData.instrument)) {
            const key = this.#instrumentKeyForUuid(dragData.instrument)
            if (isAbsent(key)) {return null}
            return {instrumentKey: key, instrumentUuid: dragData.instrument, effectUuids: dragData.uuids}
        }
        return null
    }

    canReplacePreset(entry: PresetEntry, dragData: AnyDragData): boolean {
        if (entry.source !== "user") {return false}
        const rackIntentEffect = (dragData.type === "audio-effect" || dragData.type === "midi-effect")
            && dragData.uuids !== null && isDefined(dragData.instrument)
        const rackIntentInstrument = dragData.type === "instrument" && dragData.device === null
            && dragData.effects.length > 0
        if (entry.category === "audio-effect" || entry.category === "midi-effect") {
            if (rackIntentEffect) {return false}
            const effects = this.resolveEffectBoxesFromDrag(entry.category, dragData)
            return effects.length === 1 && effects[0].name.replace(/DeviceBox$/, "") === entry.device
        }
        if (entry.category === "audio-effect-chain") {
            if (rackIntentEffect) {return false}
            return this.resolveEffectBoxesFromDrag("audio-effect", dragData).length > 0
        }
        if (entry.category === "midi-effect-chain") {
            if (rackIntentEffect) {return false}
            return this.resolveEffectBoxesFromDrag("midi-effect", dragData).length > 0
        }
        if (entry.category === "instrument") {
            if (rackIntentInstrument) {return false}
            return this.resolveDraggedInstrumentKey(dragData) === entry.device
        }
        if (entry.category === "audio-unit") {
            return isDefined(this.resolveRackCandidate(dragData))
        }
        return false
    }

    async replacePreset(entry: PresetEntry, dragData: AnyDragData): Promise<void> {
        if (!this.canReplacePreset(entry, dragData)) {return}
        const {source: _source, ...meta} = entry
        if (entry.category === "audio-effect" || entry.category === "midi-effect"
            || entry.category === "audio-effect-chain" || entry.category === "midi-effect-chain") {
            const isAudio = entry.category === "audio-effect" || entry.category === "audio-effect-chain"
            const effects = this.resolveEffectBoxesFromDrag(isAudio ? "audio-effect" : "midi-effect", dragData)
            const approved = await RuntimeNotifier.approve({
                headline: "Replace Preset?",
                message: `Replace '${entry.name}' with ${effects.length === 1 ? "the dragged effect" : `${effects.length} effects`}?`,
                approveText: "Replace",
                cancelText: "Cancel"
            })
            if (!approved) {return}
            const kind = isAudio ? PresetHeader.ChainKind.Audio : PresetHeader.ChainKind.Midi
            const bytes = PresetEncoder.encodeEffects(effects, kind)
            await PresetStorage.save(meta, bytes)
            return
        }
        if (entry.category === "instrument") {
            if (dragData.type !== "instrument" || dragData.device !== null) {return}
            const audioUnitBox = this.#audioUnitBoxForInstrumentUuid(dragData.uuid)
            if (isAbsent(audioUnitBox)) {return}
            const confirm = await Promises.tryCatch(PresetDialogs.showReplacePresetDialog({
                headline: "Replace Preset?",
                message: `Replace '${entry.name}' with the dragged instrument?`,
                initialIncludeTimeline: entry.hasTimeline === true
            }))
            if (confirm.status === "rejected") {
                if (Errors.isAbort(confirm.error)) {return}
                throw confirm.error
            }
            await PresetStorage.save({...meta, hasTimeline: confirm.value.includeTimeline},
                PresetEncoder.encode(audioUnitBox, {includeTimeline: confirm.value.includeTimeline}))
            return
        }
        if (entry.category === "audio-unit") {
            const candidate = this.resolveRackCandidate(dragData)
            if (isAbsent(candidate)) {return}
            const audioUnitBox = this.#audioUnitBoxForInstrumentUuid(candidate.instrumentUuid)
            if (isAbsent(audioUnitBox)) {return}
            let keepEntireChain = true
            let includeTimeline = false
            if (candidate.effectUuids.length === 0) {
                const choice = await Promises.tryCatch(PresetDialogs.showRackCompositionDialog(
                    `Replace '${entry.name}'?`,
                    "Replace with the entire audio chain, or just the instrument?",
                    true,
                    entry.hasTimeline === true))
                if (choice.status === "rejected") {
                    if (Errors.isAbort(choice.error)) {return}
                    throw choice.error
                }
                keepEntireChain = choice.value.choice === "entire-chain"
                includeTimeline = choice.value.includeTimeline
            } else {
                const confirm = await Promises.tryCatch(PresetDialogs.showReplacePresetDialog({
                    headline: "Replace Preset?",
                    message: `Replace '${entry.name}' with the dragged rack?`,
                    initialIncludeTimeline: entry.hasTimeline === true
                }))
                if (confirm.status === "rejected") {
                    if (Errors.isAbort(confirm.error)) {return}
                    throw confirm.error
                }
                includeTimeline = confirm.value.includeTimeline
            }
            const keep = new Set(candidate.effectUuids)
            const bytes = keepEntireChain && candidate.effectUuids.length === 0
                ? PresetEncoder.encode(audioUnitBox, {includeTimeline})
                : PresetEncoder.encode(audioUnitBox, {
                    includeTimeline,
                    excludeEffect: (box: Box) =>
                        DeviceBoxUtils.isEffectDeviceBox(box) && !keep.has(UUID.toString(box.address.uuid))
                })
            const rackMeta: RackPresetMeta = {
                category: "audio-unit",
                uuid: entry.uuid,
                name: entry.name,
                description: entry.description,
                created: entry.created,
                modified: entry.modified,
                instrument: candidate.instrumentKey,
                hasTimeline: includeTimeline
            }
            await PresetStorage.save(rackMeta, bytes)
        }
    }

    async editPreset(entry: PresetEntry): Promise<void> {
        if (entry.source !== "user") {return}
        const dialog = await Promises.tryCatch(PresetDialogs.showSavePresetDialog({
            headline: "Edit Preset",
            suggestedName: entry.name,
            suggestedDescription: entry.description,
            showTimelineToggle: false
        }))
        if (dialog.status === "rejected") {
            if (Errors.isAbort(dialog.error)) {return}
            throw dialog.error
        }
        await PresetStorage.updateMeta(UUID.parse(entry.uuid),
            {name: dialog.value.name, description: dialog.value.description})
    }

    async uploadPreset(entry: PresetEntry): Promise<void> {
        if (entry.source !== "user") {return}
        const loaded = await Promises.tryCatch(PresetStorage.load(UUID.parse(entry.uuid)))
        if (loaded.status === "rejected") {
            console.warn(loaded.error)
            RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            return
        }
        await OpenPresetAPI.get().upload(loaded.value, entry)
    }

    async deletePreset(entry: PresetEntry): Promise<void> {
        if (entry.source !== "user") {return}
        const approved = await RuntimeNotifier.approve({
            headline: "Delete Preset",
            message: `Delete '${entry.name}'?`,
            approveText: "Delete",
            cancelText: "Cancel"
        })
        if (!approved) {return}
        await PresetStorage.remove(UUID.parse(entry.uuid))
    }

    async savePresetToDisk(entry: PresetEntry): Promise<void> {
        if (entry.source !== "user") {return}
        const loaded = await Promises.tryCatch(PresetStorage.load(UUID.parse(entry.uuid)))
        if (loaded.status === "rejected") {
            console.warn(loaded.error)
            RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            return
        }
        const {source: _source, ...meta} = entry
        const bundle = await Promises.tryCatch(PresetBundle.encode(meta, loaded.value))
        if (bundle.status === "rejected") {return}
        await Files.save(bundle.value, {
            suggestedName: `${entry.name}.opb`,
            types: [FilePickerAcceptTypes.PresetBundleFileType]
        })
    }

    async duplicatePreset(entry: PresetEntry): Promise<void> {
        if (entry.source !== "user") {return}
        const loaded = await Promises.tryCatch(PresetStorage.load(UUID.parse(entry.uuid)))
        if (loaded.status === "rejected") {
            console.warn(loaded.error)
            RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            return
        }
        const {source: _source, ...meta} = entry
        const now = Date.now()
        await PresetStorage.save({
            ...meta,
            uuid: UUID.toString(UUID.generate()),
            name: Strings.getUniqueName(this.#existingUserNamesFor(meta), entry.name),
            created: now,
            modified: now
        }, loaded.value)
    }

    // User preset names within the same category and device as the given meta —
    // the slice the browser groups together, used to derive a unique copy name.
    #existingUserNamesFor(meta: PresetMeta): ReadonlyArray<string> {
        const deviceKey = deviceKeyOf(meta)
        return this.userIndex.getValue()
            .filter(preset => preset.category === meta.category && deviceKeyOf(preset) === deviceKey)
            .map(preset => preset.name)
    }

    async loadBundleFromDisk(): Promise<void> {
        const opened = await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.PresetBundleFileType]}))
        if (opened.status === "rejected") {return}
        const file = opened.value.at(0)
        if (isAbsent(file)) {return}
        const decoded = await Promises.tryCatch(PresetBundle.decode(await file.arrayBuffer()))
        if (decoded.status === "rejected") {
            console.warn(decoded.error)
            RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            return
        }
        const {meta, data} = decoded.value
        const existing = await PresetStorage.readIndex()
        if (existing.some(entry => entry.uuid === meta.uuid)) {
            const choice = await Promises.tryCatch(PresetDialogs.showPresetConflictDialog(meta.name))
            if (choice.status === "rejected") {return}
            if (choice.value === "copy") {
                await PresetStorage.save({
                    ...meta,
                    uuid: UUID.toString(UUID.generate()),
                    name: Strings.getUniqueName(this.#existingUserNamesFor(meta), meta.name)
                }, data)
                return
            }
        }
        await PresetStorage.save(meta, data)
    }

    #audioUnitBoxForInstrumentUuid(uuid: UUID.String): Nullable<AudioUnitBox> {
        const boxOpt = this.project.boxGraph.findBox(UUID.parse(uuid))
        if (boxOpt.isEmpty()) {return null}
        const box = boxOpt.unwrap()
        const adapter = this.project.boxAdapters.adapterFor(box, Devices.isAny)
        return adapter.deviceHost().audioUnitBoxAdapter().box
    }

    async activatePreset(entry: PresetEntry): Promise<void> {
        if (entry.category === "audio-unit") {
            const result = await Promises.tryCatch(
                PresetApplication.createNewAudioUnitFromRack(this.project, entry.uuid, entry.source))
            if (result.status === "rejected") {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            }
            return
        }
        if (entry.category === "instrument") {
            const result = await Promises.tryCatch(
                PresetApplication.createNewAudioUnitFromInstrument(
                    this.project, entry.uuid, entry.device, entry.source))
            if (result.status === "rejected") {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
            }
            return
        }
        if (entry.category === "audio-effect" || entry.category === "midi-effect"
            || entry.category === "audio-effect-chain" || entry.category === "midi-effect-chain") {
            const loaded = await Promises.tryCatch(PresetApplication.loadBytes(entry.uuid, entry.source))
            if (loaded.status === "rejected") {
                console.warn(loaded.error)
                RuntimeNotifier.notify({message: "Cannot load preset.", icon: "Warning"})
                return
            }
            const editing = this.project.userEditingManager.audioUnit.get()
            if (editing.isEmpty()) {
                RuntimeNotifier.notify({message: "Please select an audio unit first.", icon: "Info"})
                return
            }
            const host = this.project.boxAdapters.adapterFor(editing.unwrap().box, Devices.isHost)
            const isMidi = entry.category === "midi-effect" || entry.category === "midi-effect-chain"
            if (isMidi && host.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                RuntimeNotifier.notify({message: "The selected audio unit does not accept MIDI.", icon: "Info"})
                return
            }
            const field = isMidi ? host.midiEffects.field() : host.audioEffects.field()
            const insertIndex = field.pointerHub.incoming().length
            const chainKind = isMidi ? PresetHeader.ChainKind.Midi : PresetHeader.ChainKind.Audio
            this.project.editing.modify(() => {
                const attempt = PresetDecoder.insertEffectChain(
                    loaded.value, host.audioUnitBoxAdapter().box, insertIndex, chainKind)
                if (attempt.isFailure()) {
                    RuntimeNotifier.notify({message: "Cannot apply preset.", icon: "Warning"})
                }
            })
            this.project.loadScriptDevices()
        }
    }
}