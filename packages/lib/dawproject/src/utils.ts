import {BoolParameterSchema, Interpolation, RealParameterSchema, Unit} from "./schema"
import {Xml} from "@opendaw/lib-xml"
import {asDefined, isDefined} from "@opendaw/lib-std"
import {Interpolation as OpenDAWInterpolation, semitoneToHz} from "@opendaw/lib-dsp"

export namespace ParameterEncoder {
    export const bool = (id: string, value: boolean, name?: string) => Xml.element({
        id, name, value
    }, BoolParameterSchema)

    export const linear = (id: string, value: number, min?: number, max?: number, name?: string) => Xml.element({
        id, name, min, max, value, unit: Unit.LINEAR
    }, RealParameterSchema)

    export const normalized = (id: string, value: number, min?: number, max?: number, name?: string) => Xml.element({
        id, name, min, max, value, unit: Unit.NORMALIZED
    }, RealParameterSchema)
}

export namespace ParameterDecoder {
    export const readValue = (schema: RealParameterSchema): number => {
        const value = asDefined(schema.value, "RealParameter has no value")
        if (schema.unit === Unit.NORMALIZED && isDefined(schema.min) && isDefined(schema.max)) {
            return schema.min + value * (schema.max - schema.min)
        } else if (schema.unit === Unit.SEMITONES) {
            return semitoneToHz(value)
        }
        return value
    }
}

export namespace TempoAutomationConverter {
    /**
     * Converts a normalized value (0-1) to BPM using the given min/max range.
     */
    export const normalizedToBpm = (normalized: number, minBpm: number, maxBpm: number): number =>
        minBpm + normalized * (maxBpm - minBpm)

    /**
     * Converts a BPM value to normalized (0-1) using the given min/max range.
     */
    export const bpmToNormalized = (bpm: number, minBpm: number, maxBpm: number): number =>
        (bpm - minBpm) / (maxBpm - minBpm)

    /**
     * Converts openDAW interpolation type to DawProject interpolation.
     * - "none" (hold/step) → Interpolation.HOLD
     * - "linear" or "curve" → Interpolation.LINEAR
     */
    export const toDawProjectInterpolation = (interpolation: OpenDAWInterpolation): Interpolation =>
        interpolation.type === "none" ? Interpolation.HOLD : Interpolation.LINEAR

    /**
     * Converts DawProject interpolation to openDAW interpolation type.
     * - Interpolation.HOLD → Interpolation.None
     * - Interpolation.LINEAR → Interpolation.Linear
     */
    export const fromDawProjectInterpolation = (interpolation: Interpolation | undefined): OpenDAWInterpolation =>
        interpolation === Interpolation.HOLD ? OpenDAWInterpolation.None : OpenDAWInterpolation.Linear
}