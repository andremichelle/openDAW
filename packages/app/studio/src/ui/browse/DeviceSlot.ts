import {asInstanceOf, int, isAbsent, isInstanceOf, Option, Optional, UUID} from "@opendaw/lib-std"
import {Box, Field, IndexedBox} from "@opendaw/lib-box"
import {
    AudioCompositeAdapter,
    AudioUnitBoxAdapter,
    DeviceHost,
    Devices,
    EffectDeviceBoxAdapter,
    EffectPointerType,
    InstrumentBox,
    InstrumentCompositeCellBoxAdapter,
    InstrumentFactories,
    InstrumentFactory,
    PresetDecoder,
    PresetHeader,
    TrackType
} from "@opendaw/studio-adapters"
import {AudioEffectCompositeCellBox, AudioUnitBox, InstrumentCompositeBox} from "@opendaw/studio-boxes"
import {EffectFactories, Project} from "@opendaw/studio-core"
import {PresetCategoryKey} from "@/ui/browse/PresetService"

// where the device dialog creates or replaces a device
export type DeviceSlot =
    | { readonly type: "insert", readonly host: DeviceHost, readonly accepts: "audio" | "midi", readonly index: int }
    | { readonly type: "replace-effect", readonly host: DeviceHost, readonly accepts: "audio" | "midi", readonly index: int }
    | { readonly type: "replace-instrument", readonly host: DeviceHost }
    | { readonly type: "new-instrument", readonly anchor: Option<UUID.Bytes> }
    | { readonly type: "new-layer", readonly host: DeviceHost, readonly composite: InstrumentCompositeBox }
    | { readonly type: "new-entry", readonly host: DeviceHost, readonly composite: AudioCompositeAdapter }

export namespace DeviceSlot {
    export const forEffect = (adapter: EffectDeviceBoxAdapter): DeviceSlot => ({
        type: "replace-effect", host: adapter.deviceHost(), accepts: adapter.accepts === "midi" ? "midi" : "audio",
        index: adapter.indexField.getValue()
    })

    export const categoryOf = (slot: DeviceSlot): PresetCategoryKey => {
        switch (slot.type) {
            case "insert":
            case "replace-effect":
                return slot.accepts === "midi" ? "midi-effect" : "audio-effect"
            case "new-entry":
                return "audio-effect"
            case "replace-instrument":
            case "new-instrument":
            case "new-layer":
                return "instrument"
        }
    }

    // whether notes played into the slot's audio unit reach what is auditioned
    export const takesNotes = (slot: DeviceSlot): boolean => slot.type === "new-instrument" || slot.type === "new-layer"
        || slot.host.audioUnitBoxAdapter().inputAdapter.mapOr(input => input.accepts === "midi", false)

    export const isReplace = (slot: DeviceSlot): boolean =>
        slot.type === "replace-effect" || slot.type === "replace-instrument"

    // the instrument a replace-instrument slot swaps, None when nothing there can be swapped
    export const currentInstrument = (slot: DeviceSlot): Option<InstrumentBox> => {
        if (slot.type !== "replace-instrument") {return Option.None}
        const box = slot.host.inputField.pointerHub.incoming().at(0)?.box
        return isAbsent(box) ? Option.None : Option.wrap(box as InstrumentBox)
    }

    export const currentEffect = (slot: DeviceSlot): Option<EffectDeviceBoxAdapter> => {
        if (slot.type !== "replace-effect") {return Option.None}
        return DeviceHost.chainOf(slot.host, slot.accepts)
            .flatMap(chain => Option.wrap(chain.adapters().find(adapter => adapter.indexField.getValue() === slot.index)))
    }

    export const currentDeviceKey = (slot: DeviceSlot): Option<string> => {
        switch (slot.type) {
            case "replace-effect":
                return currentEffect(slot).flatMap(adapter => Option.wrap(EffectFactories.keyOfBox(adapter.box)))
            case "replace-instrument":
                return currentInstrument(slot).flatMap(box => Option.wrap(InstrumentFactories.keyOfBox(box)))
            default:
                return Option.None
        }
    }

    // whether an instrument factory can take the place of what the slot holds
    export const acceptsInstrument = (slot: DeviceSlot, factory: InstrumentFactory): boolean => {
        switch (slot.type) {
            case "new-instrument":
                return factory !== InstrumentFactories.Tape
            case "new-layer":
                return InstrumentFactories.isLayerInstrument(factory)
            case "replace-instrument":
                if (isInstanceOf(slot.host, InstrumentCompositeCellBoxAdapter)) {
                    return InstrumentFactories.isLayerInstrument(factory)
                }
                return factory.trackType === TrackType.Notes
                    && slot.host.inputAdapter.mapOr(input => input.accepts === "midi", false)
            default:
                return false
        }
    }

    // a rack brings a whole audio unit, so it never goes into a layer
    export const acceptsRack = (slot: DeviceSlot, factory: InstrumentFactory): boolean => {
        switch (slot.type) {
            case "new-instrument":
                return true
            case "replace-instrument":
                return isInstanceOf(slot.host, AudioUnitBoxAdapter) && factory.trackType === TrackType.Notes
                    && slot.host.inputAdapter.mapOr(input => input.accepts === "midi", false)
            default:
                return false
        }
    }

    // a new audio unit from rack bytes, or the whole unit at the slot replaced by it, its tracks kept unless asked
    export const placeRack = (project: Project, slot: DeviceSlot, bytes: ArrayBuffer, keepTimeline: boolean): boolean => {
        switch (slot.type) {
            case "new-instrument": {
                const insertIndex = slot.anchor.flatMap(unit => project.api.audioUnitIndex(unit)).unwrapOrUndefined()
                const first = PresetDecoder.decode(bytes, project.skeleton, insertIndex).at(0)
                if (isAbsent(first)) {return false}
                project.userEditingManager.audioUnit.edit(first.editing)
                return true
            }
            case "replace-instrument":
                return isInstanceOf(slot.host, AudioUnitBoxAdapter)
                    && PresetDecoder.replaceAudioUnit(bytes, slot.host.box, {keepTimeline}).isSuccess()
            default:
                return false
        }
    }

    export const canReplaceInstrument = (host: DeviceHost): boolean =>
        isInstanceOf(host, InstrumentCompositeCellBoxAdapter)
        || (isInstanceOf(host, AudioUnitBoxAdapter) && host.inputAdapter.mapOr(input => input.accepts === "midi", false))

    // a new-entry slot appends the entry it places into
    const effectField = (slot: DeviceSlot): Option<Field<EffectPointerType>> => {
        if (slot.type === "insert" || slot.type === "replace-effect") {return DeviceHost.chainFieldOf(slot.host, slot.accepts)}
        if (slot.type !== "new-entry") {return Option.None}
        const {entries} = slot.composite.box
        return Option.wrap(AudioEffectCompositeCellBox.create(entries.graph, UUID.generate(), box => {
            box.composite.refer(entries)
            box.index.setValue(IndexedBox.collectIndexedBoxes(entries).length)
        }).audioEffects)
    }

    const removeReplaced = (slot: DeviceSlot, replaced: Option<EffectDeviceBoxAdapter>): void =>
        replaced.ifSome(adapter => {if (slot.type === "replace-effect") {Devices.deleteEffectDevices([adapter])}})

    // an effect box created by `create` at the slot, the replaced effect removed afterward
    export const placeEffect = (slot: DeviceSlot, create: (field: Field<EffectPointerType>, index: int) => Box): Option<Box> => {
        const replaced = currentEffect(slot)
        return effectField(slot).map(field => {
            const box = create(field, slot.type === "insert" || slot.type === "replace-effect" ? slot.index : 0)
            removeReplaced(slot, replaced)
            return box
        })
    }

    // an instrument from `factory` at the slot: a new unit, or swapped into the unit or layer
    export const placeInstrument = (project: Project, slot: DeviceSlot, factory: InstrumentFactory): Option<InstrumentBox> => {
        const {api} = project
        switch (slot.type) {
            case "new-instrument": {
                const {audioUnitBox, instrumentBox} = api.createAnyInstrument(factory)
                api.placeAudioUnitBefore(audioUnitBox, slot.anchor)
                return Option.wrap(instrumentBox)
            }
            case "replace-instrument": {
                if (isInstanceOf(slot.host, InstrumentCompositeCellBoxAdapter)) {
                    return api.setLayerInstrument(slot.host.box, factory).asOption()
                }
                return currentInstrument(slot).flatMap(box => api.replaceMIDIInstrument(box, factory).asOption())
            }
            case "new-layer":
                return api.createCompositeLayer(slot.composite, factory).asOption().map(({instrumentBox}) => instrumentBox)
            default:
                return Option.None
        }
    }

    export const hasTimeline = (slot: DeviceSlot): boolean =>
        slot.type === "replace-instrument" && slot.host.isAudioUnit
        && slot.host.audioUnitBoxAdapter().box.tracks.pointerHub.incoming().length > 0

    // applies preset bytes at the slot, false when the preset does not fit
    export const placePreset = (project: Project, slot: DeviceSlot, bytes: ArrayBuffer,
                                device: string, keepTimeline: boolean): boolean => {
        switch (slot.type) {
            case "insert":
            case "replace-effect": {
                const chainKind = slot.accepts === "midi" ? PresetHeader.ChainKind.Midi : PresetHeader.ChainKind.Audio
                const replaced = currentEffect(slot)
                return effectField(slot).mapOr(field => {
                    const attempt = PresetDecoder.insertEffectChain(bytes, field, slot.index, chainKind)
                    if (attempt.isFailure()) {return false}
                    removeReplaced(slot, replaced)
                    return true
                }, false)
            }
            case "new-entry":
                return effectField(slot).mapOr(field => {
                    if (PresetDecoder.insertEffectChain(bytes, field, 0, PresetHeader.ChainKind.Audio).isSuccess()) {return true}
                    field.box.delete()
                    return false
                }, false)
            case "replace-instrument": {
                if (isInstanceOf(slot.host, InstrumentCompositeCellBoxAdapter)) {
                    return PresetDecoder.replaceLayerInstrument(bytes, slot.host.box).isSuccess()
                }
                return PresetDecoder.replaceAudioUnit(bytes, slot.host.audioUnitBoxAdapter().box,
                    {keepMIDIEffects: true, keepAudioEffects: true, keepTimeline}).isSuccess()
            }
            case "new-instrument": {
                const factory = InstrumentFactories.Named[device as InstrumentFactories.Keys]
                if (isAbsent(factory)) {return false}
                const {audioUnitBox} = project.api.createAnyInstrument(factory)
                project.api.placeAudioUnitBefore(audioUnitBox, slot.anchor)
                return PresetDecoder.replaceAudioUnit(bytes, asInstanceOf(audioUnitBox, AudioUnitBox),
                    {keepMIDIEffects: true, keepAudioEffects: true}).isSuccess()
            }
            case "new-layer": {
                const factory: Optional<InstrumentFactory> = InstrumentFactories.Named[device as InstrumentFactories.Keys]
                if (isAbsent(factory)) {return false}
                return project.api.createCompositeLayer(slot.composite, factory).asOption()
                    .mapOr(({cellBox}) => PresetDecoder.replaceLayerInstrument(bytes, cellBox).isSuccess(), false)
            }
        }
    }
}
