import {BoxGraph} from "@opendaw/lib-box"
import {TrackBox} from "@opendaw/studio-boxes"
import {Attempt, Attempts, clamp, int} from "@opendaw/lib-std"
import {RegionOverlap} from "./timeline/RegionOverlap"
import {TempoRange} from "./TempoRange"
import {BaseFrequencyRange} from "./BaseFrequencyRange"

export namespace Validator {
    export const isTimeSignatureValid = (numerator: int, denominator: int): Attempt<[int, int], string> => {
        if (!Number.isInteger(numerator) || numerator < 1 || numerator > 31) {
            return Attempts.err("Numerator needs to be a interger between 1 and 31")
        }
        if (!Number.isInteger(denominator) || denominator < 1 || denominator > 32 || (denominator & (denominator - 1)) !== 0) {
            return Attempts.err("Denominator must be a power of two between 1 and 32")
        }
        return Attempts.ok([numerator, denominator])
    }

    export const clampBpm = (bpm: number): number => Number.isFinite(bpm)
        ? clamp(bpm, TempoRange.min, TempoRange.max)
        : TempoRange.default

    export const clampBaseFrequency = (hz: number): number => Number.isFinite(hz)
        ? clamp(hz, BaseFrequencyRange.min, BaseFrequencyRange.max)
        : BaseFrequencyRange.default

    export const hasOverlappingRegions = (boxGraph: BoxGraph): boolean => boxGraph.boxes()
        .some(box => box instanceof TrackBox && RegionOverlap.find(RegionOverlap.sortedRegions(box)).nonEmpty())
}