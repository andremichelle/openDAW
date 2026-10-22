import {int} from "@opendaw/lib-std"
import {AudioUnitType} from "@opendaw/studio-enums"

export const AudioUnitOrdering: Record<string, int> = {
    [AudioUnitType.Instrument]: 1,
    [AudioUnitType.Aux]: 2,
    [AudioUnitType.Bus]: 0,
    [AudioUnitType.Output]: 3
} as const