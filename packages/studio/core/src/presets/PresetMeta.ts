import {int, UUID} from "@opendaw/lib-std"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories} from "../EffectFactories"

type PresetCommon = {
    uuid: UUID.String
    name: string
    description: string
    created: number
    modified: number
    hasTimeline?: boolean
    tags?: ReadonlyArray<string>
    author?: string
    license?: string
    credits?: string
    folder?: string
    download?: PresetDownload
}

// the cloud files a stock preset loads, size in bytes is 0 if unknown
export type PresetDownload = {
    samples: ReadonlyArray<UUID.String>
    soundfonts: ReadonlyArray<UUID.String>
    size: int
}

export const CATEGORIES = [
    "instrument", "audio-effect", "midi-effect", "audio-unit", "audio-effect-chain", "midi-effect-chain"
] as const

export type PresetCategory = typeof CATEGORIES[number]

export type InstrumentPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[0]
    device: InstrumentFactories.Keys
}

export type AudioEffectPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[1]
    device: EffectFactories.AudioEffectKeys
}

export type MidiEffectPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[2]
    device: EffectFactories.MidiEffectKeys
}

export type RackPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[3]
    instrument: InstrumentFactories.Keys
}

export type AudioEffectChainPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[4]
}

export type MidiEffectChainPresetMeta = PresetCommon & {
    category: typeof CATEGORIES[5]
}

export type PresetMeta =
    | InstrumentPresetMeta
    | AudioEffectPresetMeta
    | MidiEffectPresetMeta
    | RackPresetMeta
    | AudioEffectChainPresetMeta
    | MidiEffectChainPresetMeta

export type PresetSource = "stock" | "user"

export type PresetEntry = PresetMeta & { source: PresetSource }
