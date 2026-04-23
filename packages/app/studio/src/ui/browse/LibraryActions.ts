import {Errors, isAbsent, isDefined, isNull, Nullable, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {DeviceBoxUtils, Devices, InstrumentFactories, PresetDecoder, PresetEncoder, PresetHeader} from "@opendaw/studio-adapters"
import {
    AudioEffectChainPresetMeta,
    AudioEffectPresetMeta,
    EffectFactories,
    InstrumentPresetMeta,
    MidiEffectChainPresetMeta,
    MidiEffectPresetMeta,
    OpenPresetAPI,
    PresetEntry,
    PresetStorage,
    Project,
    RackPresetMeta
} from "@opendaw/studio-core"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {DefaultInstrumentFactory} from "@/ui/defaults/DefaultInstrumentFactory"
import {AnyDragData} from "@/ui/AnyDragData"
import {PresetDialogs} from "@/ui/browse/PresetDialogs"
import {PresetApplication} from "@/ui/browse/PresetApplication"

export type LibraryCategoryKey = "instrument" | "audio-effect" | "midi-effect"
export type LibraryEffectKind = "audio-effect" | "midi-effect"

export class LibraryActions {
    constructor(readonly project: Project) {}

    createInstrument(key: InstrumentFactories.Keys): void {
        const factory = InstrumentFactories.Named[key]
        this.project.editing.modify(() => DefaultInstrumentFactory.create(this.project.api, factory))
    }

    createEffect(kind: LibraryEffectKind, key: string): void {
        const factory = EffectFactories.MergedNamed[key as keyof typeof EffectFactories.MergedNamed]
        const audioUnitOption = this.project.userEditingManager.audioUnit.get()
        if (audioUnitOption.isEmpty()) {
            RuntimeNotifier.info({
                headline: "No Source Device Yet",
                message: "Please create an instrument or select an audio-bus first."
            }).finally()
            return
        }
        audioUnitOption.ifSome(vertex => {
            const deviceHost = this.project.boxAdapters.adapterFor(vertex.box, Devices.isHost)
            if (kind === "midi-effect" && deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                RuntimeNotifier.info({
                    headline: "Add Midi Effect",
                    message: "The selected audio unit does not have a midi input."
                }).finally()
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

    createDevice(category: LibraryCategoryKey, deviceKey: string): void {
        if (category === "instrument") {
            this.createInstrument(deviceKey as InstrumentFactories.Keys)
        } else {
            this.createEffect(category, deviceKey)
        }
    }

    resolveEffectBoxesFromDrag(kind: LibraryEffectKind, dragData: AnyDragData): ReadonlyArray<IndexedBox> {
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

    async saveAsSingleEffectPreset(category: LibraryEffectKind,
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
            headline: isAudio ? "Save Audio Stash" : "Save MIDI Stash",
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

    async saveAsInstrumentPreset(deviceKey: InstrumentFactories.Keys, sourceUuid: UUID.String): Promise<void> {
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
        await PresetStorage.save(meta, PresetEncoder.encode(audioUnitBox,
            {includeTimeline: dialog.value.includeTimeline}))
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
                message: `Replace '${entry.name}' with the dragged instrument?`
            }))
            if (confirm.status === "rejected") {
                if (Errors.isAbort(confirm.error)) {return}
                throw confirm.error
            }
            await PresetStorage.save(meta, PresetEncoder.encode(audioUnitBox,
                {includeTimeline: confirm.value.includeTimeline}))
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
                    true))
                if (choice.status === "rejected") {
                    if (Errors.isAbort(choice.error)) {return}
                    throw choice.error
                }
                keepEntireChain = choice.value.choice === "entire-chain"
                includeTimeline = choice.value.includeTimeline
            } else {
                const confirm = await Promises.tryCatch(PresetDialogs.showReplacePresetDialog({
                    headline: "Replace Preset?",
                    message: `Replace '${entry.name}' with the dragged rack?`
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
                instrument: candidate.instrumentKey
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
            await RuntimeNotifier.info({
                headline: "Could Not Load Preset",
                message: String(loaded.error)
            })
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
                await RuntimeNotifier.info({
                    headline: "Could Not Load Preset", message: String(result.error)
                })
            }
            return
        }
        if (entry.category === "instrument") {
            const result = await Promises.tryCatch(
                PresetApplication.createNewAudioUnitFromInstrument(
                    this.project, entry.uuid, entry.device, entry.source))
            if (result.status === "rejected") {
                await RuntimeNotifier.info({
                    headline: "Could Not Load Preset", message: String(result.error)
                })
            }
            return
        }
        if (entry.category === "audio-effect" || entry.category === "midi-effect"
            || entry.category === "audio-effect-chain" || entry.category === "midi-effect-chain") {
            const loaded = await Promises.tryCatch(PresetApplication.loadBytes(entry.uuid, entry.source))
            if (loaded.status === "rejected") {
                await RuntimeNotifier.info({
                    headline: "Could Not Load Preset",
                    message: String(loaded.error)
                })
                return
            }
            const editing = this.project.userEditingManager.audioUnit.get()
            if (editing.isEmpty()) {
                await RuntimeNotifier.info({
                    headline: "No Source Device",
                    message: "Please select an audio unit first."
                })
                return
            }
            const host = this.project.boxAdapters.adapterFor(editing.unwrap().box, Devices.isHost)
            const isMidi = entry.category === "midi-effect" || entry.category === "midi-effect-chain"
            if (isMidi && host.inputAdapter.mapOr(input => input.accepts !== "midi", true)) {
                await RuntimeNotifier.info({
                    headline: "Incompatible Audio Unit",
                    message: "The selected audio unit does not accept MIDI."
                })
                return
            }
            const field = isMidi ? host.midiEffects.field() : host.audioEffects.field()
            const insertIndex = field.pointerHub.incoming().length
            const chainKind = isMidi ? PresetHeader.ChainKind.Midi : PresetHeader.ChainKind.Audio
            this.project.editing.modify(() => {
                const attempt = PresetDecoder.insertEffectChain(
                    loaded.value, host.audioUnitBoxAdapter().box, insertIndex, chainKind)
                if (attempt.isFailure()) {
                    RuntimeNotifier.info({
                        headline: "Can't Apply Preset",
                        message: attempt.failureReason()
                    }).then()
                }
            })
            this.project.loadScriptDevices()
        }
    }
}