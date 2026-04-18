import {UUID} from "@opendaw/lib-std"

export type PresetCategory =
    | "instrument"
    | "audio-effect"
    | "midi-effect"
    | "audio-unit"
    | "audio-effect-chain"
    | "midi-effect-chain"

export type PresetMeta = {
    uuid: UUID.String
    name: string
    device: string
    category: PresetCategory
    author: string
    description: string
    created: number
}

export type PresetSource = "stock" | "user"

export type PresetEntry = PresetMeta & {source: PresetSource}
