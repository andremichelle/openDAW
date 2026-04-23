import {UUID} from "@opendaw/lib-std"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories} from "../EffectFactories"

type PresetCommon = {
    uuid: UUID.String
    name: string
    description: string
    created: number
    modified: number
    hasTimeline?: boolean
}

export type InstrumentPresetMeta = PresetCommon & {
    category: "instrument"
    device: InstrumentFactories.Keys
}

export type AudioEffectPresetMeta = PresetCommon & {
    category: "audio-effect"
    device: EffectFactories.AudioEffectKeys
}

export type MidiEffectPresetMeta = PresetCommon & {
    category: "midi-effect"
    device: EffectFactories.MidiEffectKeys
}

export type RackPresetMeta = PresetCommon & {
    category: "audio-unit"
    instrument: InstrumentFactories.Keys
}

export type AudioEffectChainPresetMeta = PresetCommon & {
    category: "audio-effect-chain"
}

export type MidiEffectChainPresetMeta = PresetCommon & {
    category: "midi-effect-chain"
}

export type PresetMeta =
    | InstrumentPresetMeta
    | AudioEffectPresetMeta
    | MidiEffectPresetMeta
    | RackPresetMeta
    | AudioEffectChainPresetMeta
    | MidiEffectChainPresetMeta

export type PresetCategory = PresetMeta["category"]

export type PresetSource = "stock" | "user"

export type PresetEntry = PresetMeta & {source: PresetSource}
