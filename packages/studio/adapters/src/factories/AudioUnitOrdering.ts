import {int} from "@moises-ai/lib-std"
import {AudioUnitType} from "@moises-ai/studio-enums"

export const AudioUnitOrdering: Record<string, int> = {
    [AudioUnitType.Instrument]: 0,
    [AudioUnitType.Aux]: 1,
    [AudioUnitType.Bus]: 2,
    [AudioUnitType.Output]: 3
} as const