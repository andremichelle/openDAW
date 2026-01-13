import {BoxGraph} from "@moises-ai/lib-box"
import {AudioRegionBox, BoxVisitor, TrackBox} from "@moises-ai/studio-boxes"
import {Arrays, Attempt, Attempts, clamp, int} from "@moises-ai/lib-std"
import {UnionBoxTypes} from "./unions"
import {TimeBase} from "@moises-ai/lib-dsp"
import {TempoRange} from "./TempoRange"

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
        : 120.0

    export const hasOverlappingRegions = (boxGraph: BoxGraph): boolean => boxGraph.boxes()
        .some(box => box.accept<BoxVisitor<boolean>>({
            visitTrackBox: (box: TrackBox): boolean => {
                for (const [current, next] of Arrays.iterateAdjacent(box.regions.pointerHub.incoming()
                    .map(({box}) => UnionBoxTypes.asRegionBox(box))
                    .sort(({position: a}, {position: b}) => a.getValue() - b.getValue()))) {
                    if (current instanceof AudioRegionBox && current.timeBase.getValue() === TimeBase.Seconds) {
                        return false
                    }
                    if (current.position.getValue() + current.duration.getValue() > next.position.getValue()) {
                        return true
                    }
                }
                return false
            }
        }) ?? false)
}