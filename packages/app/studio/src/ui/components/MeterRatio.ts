import {unitValue, ValueMapping} from "@opendaw/lib-std"

// a meter reading that is not a finite dB value (NaN, ±Infinity) draws as empty
export const meterRatio = (mapping: ValueMapping<number>, db: number): unitValue =>
    Number.isFinite(db) ? mapping.x(db) : 0.0
