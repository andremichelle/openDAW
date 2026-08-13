import {ByteArrayInput, isAbsent, isDefined, isInstanceOf, Option, tryCatch, UUID} from "@opendaw/lib-std"
import {BoxGraph, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, NoopInstrumentBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {DeviceBoxUtils, InstrumentFactories, PresetHeader} from "@opendaw/studio-adapters"
import {EffectFactories} from "../EffectFactories"
import {PresetMeta} from "./PresetMeta"

export type PresetInspection =
    | {category: "audio-unit", name: string, instrument: InstrumentFactories.Keys}
    | {category: "audio-effect", name: string, device: EffectFactories.AudioEffectKeys}
    | {category: "midi-effect", name: string, device: EffectFactories.MidiEffectKeys}
    | {category: "audio-effect-chain", name: string}
    | {category: "midi-effect-chain", name: string}

export type PresetCommonMeta = {
    uuid: UUID.String
    name: string
    description: string
    created: number
    modified: number
    hasTimeline?: boolean
}

const HEADER_SIZE = 8

export namespace PresetInspector {
    export const isPresetBinary = (bytes: Uint8Array): boolean => {
        if (bytes.byteLength < HEADER_SIZE) {return false}
        const header = new ByteArrayInput(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + HEADER_SIZE))
        return header.readInt() === PresetHeader.MAGIC_HEADER_OPEN
    }

    // Recovers the category and a display name from a raw .odp binary. The binary carries no metadata,
    // so the category is derived from the graph: a wrapper audio-unit with a NoopInstrumentBox is an
    // effect preset (single effect or chain), anything else is a rack.
    export const inspect = (bytes: Uint8Array): Option<PresetInspection> => {
        if (bytes.byteLength < HEADER_SIZE) {return Option.None}
        const header = new ByteArrayInput(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + HEADER_SIZE))
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {return Option.None}
        if (header.readInt() !== PresetHeader.FORMAT_VERSION) {return Option.None}
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const decoded = tryCatch(() => graph.fromArrayBuffer(
            bytes.buffer.slice(bytes.byteOffset + HEADER_SIZE, bytes.byteOffset + bytes.byteLength), false))
        if (decoded.status === "failure") {return Option.None}
        const audioUnit = graph.boxes()
            .filter(box => isInstanceOf(box, AudioUnitBox))
            .find(box => box.type.getValue() !== AudioUnitType.Output)
        if (isAbsent(audioUnit)) {return Option.None}
        const inputBox = audioUnit.input.pointerHub.incoming().at(0)?.box
        if (isAbsent(inputBox)) {return Option.None}
        if (isInstanceOf(inputBox, NoopInstrumentBox)) {
            const audioEffects = IndexedBox.collectIndexedBoxes(audioUnit.audioEffects)
            const midiEffects = IndexedBox.collectIndexedBoxes(audioUnit.midiEffects)
            if (audioEffects.length > 0 && midiEffects.length === 0) {
                if (audioEffects.length === 1) {
                    const key = EffectFactories.keyOfBox(audioEffects[0])
                    if (isDefined(key) && Object.hasOwn(EffectFactories.AudioNamed, key)) {
                        const device = key as EffectFactories.AudioEffectKeys
                        return Option.wrap({
                            category: "audio-effect", name: EffectFactories.AudioNamed[device].defaultName, device
                        })
                    }
                }
                return Option.wrap({category: "audio-effect-chain", name: "Audio Effect Chain"})
            }
            if (midiEffects.length > 0 && audioEffects.length === 0) {
                if (midiEffects.length === 1) {
                    const key = EffectFactories.keyOfBox(midiEffects[0])
                    if (isDefined(key) && Object.hasOwn(EffectFactories.MidiNamed, key)) {
                        const device = key as EffectFactories.MidiEffectKeys
                        return Option.wrap({
                            category: "midi-effect", name: EffectFactories.MidiNamed[device].defaultName, device
                        })
                    }
                }
                return Option.wrap({category: "midi-effect-chain", name: "MIDI Effect Chain"})
            }
            return Option.None
        }
        const stripped = inputBox.name.replace(/DeviceBox$/, "")
        if (!Object.hasOwn(InstrumentFactories.Named, stripped)) {return Option.None}
        const instrument = stripped as InstrumentFactories.Keys
        const labeled = DeviceBoxUtils.isInstrumentDeviceBox(inputBox) ? inputBox.label.getValue() : ""
        const name = labeled.length > 0 ? labeled : InstrumentFactories.Named[instrument].defaultName
        return Option.wrap({category: "audio-unit", name, instrument})
    }

    export const toMeta = (inspection: PresetInspection, common: PresetCommonMeta): PresetMeta => {
        switch (inspection.category) {
            case "audio-unit":
                return {...common, category: "audio-unit", instrument: inspection.instrument}
            case "audio-effect":
                return {...common, category: "audio-effect", device: inspection.device}
            case "midi-effect":
                return {...common, category: "midi-effect", device: inspection.device}
            case "audio-effect-chain":
                return {...common, category: "audio-effect-chain"}
            case "midi-effect-chain":
                return {...common, category: "midi-effect-chain"}
        }
    }
}
