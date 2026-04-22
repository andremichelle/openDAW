import {byte, int, Nullable, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, Sample, Soundfont} from "@opendaw/studio-adapters"
import {EffectFactories, PresetCategory, PresetSource} from "@opendaw/studio-core"

export type DragCopyHint = { copy?: boolean }
export type DragSample = { type: "sample", sample: Sample } & DragCopyHint
export type DragSoundfont = { type: "soundfont", soundfont: Soundfont } & DragCopyHint
export type DragFile = { type: "file", file: File /* This cannot be accessed while dragging! */ } & DragCopyHint
export type DragDevice = (
    {
        type: "midi-effect" | "audio-effect"
        uuids: ReadonlyArray<UUID.String>
        instrument: Nullable<UUID.String>
    } |
    {
        type: "midi-effect"
        uuids: null
        device: EffectFactories.MidiEffectKeys
    } |
    {
        type: "audio-effect"
        uuids: null
        device: EffectFactories.AudioEffectKeys
    } |
    {
        type: "instrument"
        device: InstrumentFactories.Keys
    } |
    {
        type: "instrument"
        device: null
        uuid: UUID.String
        effects: ReadonlyArray<UUID.String>
    } |
    {
        type: "playfield-slot"
        index: byte
        uuid: string
    }) & DragCopyHint
export type DragChannelStrip = { type: "channelstrip", uuid: string, start_index: int } & DragCopyHint
export type DragPreset = {
    type: "preset"
    category: PresetCategory
    source: PresetSource
    uuid: UUID.String
    device: Nullable<InstrumentFactories.Keys>
} & DragCopyHint

export type AnyDragData = DragSample | DragFile | DragDevice | DragChannelStrip | DragSoundfont | DragPreset