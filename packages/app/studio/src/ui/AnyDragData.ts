import {byte, int} from "@moises-ai/lib-std"
import {InstrumentFactories, Sample, Soundfont} from "@moises-ai/studio-adapters"
import {EffectFactories} from "@moises-ai/studio-core"

export type DragCopyHint = { copy?: boolean }
export type DragSample = { type: "sample", sample: Sample } & DragCopyHint
export type DragSoundfont = { type: "soundfont", soundfont: Soundfont } & DragCopyHint
export type DragFile = { type: "file", file: File /* This cannot be accessed while dragging! */ } & DragCopyHint
export type DragDevice = (
    {
        type: "midi-effect" | "audio-effect"
        start_index: int
    } |
    {
        type: "midi-effect"
        start_index: null
        device: EffectFactories.MidiEffectKeys
    } |
    {
        type: "audio-effect"
        start_index: null
        device: EffectFactories.AudioEffectKeys
    } |
    {
        type: "instrument"
        device: InstrumentFactories.Keys
    } |
    {
        type: "playfield-slot"
        index: byte
        uuid: string
    }) & DragCopyHint
export type DragChannelStrip = { type: "channelstrip", uuid: string, start_index: int } & DragCopyHint

export type AnyDragData = DragSample | DragFile | DragDevice | DragChannelStrip | DragSoundfont