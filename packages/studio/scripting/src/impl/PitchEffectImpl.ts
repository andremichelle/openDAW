import {PitchEffect} from "../Api"
import {float, int} from "@moises-ai/lib-std"

export class PitchEffectImpl implements PitchEffect {
    readonly key = "pitch" as const

    label: string
    octaves: int
    semiTones: int
    cents: float
    enabled: boolean

    constructor(props?: Partial<PitchEffect>) {
        this.label = props?.label ?? "Pitch"
        this.octaves = props?.octaves ?? 0 | 0
        this.semiTones = props?.semiTones ?? 0 | 0
        this.cents = props?.cents ?? 0.0
        this.enabled = props?.enabled ?? true
    }
}
