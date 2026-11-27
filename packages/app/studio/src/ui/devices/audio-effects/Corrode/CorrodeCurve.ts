import {Arrays} from "@opendaw/lib-std"

export namespace CorrodeCurve {
    export const PeakTop = 0.25
    export const RangeDb = 36.0
    export const GridFrequencies: ReadonlyArray<number> = [
        ...Arrays.create(index => (index + 1) * 100.0, 9),
        ...Arrays.create(index => (index + 1) * 1000.0, 9),
        10000.0
    ]
    export const isDecade = (hz: number): boolean => hz === 100.0 || hz === 1000.0 || hz === 10000.0
    export const magnitudeDb = (hz: number, center: number, q: number): number => {
        const detune = q * (hz / center - center / hz)
        return -10.0 * Math.log10(1.0 + detune * detune)
    }
    export const curveY = (db: number): number => Math.min(PeakTop - db / RangeDb * (1.0 - PeakTop), 1.0)
}
