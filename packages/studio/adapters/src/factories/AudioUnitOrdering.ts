import {int} from "@opendaw/lib-std"
import {AudioUnitType} from "@opendaw/studio-enums"

export const AudioUnitOrdering: Record<string, int> = {
    [AudioUnitType.Instrument]: 0,
    [AudioUnitType.Aux]: 1,
    [AudioUnitType.Bus]: 2,
    [AudioUnitType.Output]: 3
} as const