import {LinearScale, LogScale} from "../../../../../../../studio/core/src/ui/canvas/scale.ts"
import {BiquadCoeff} from "@opendaw/lib-dsp"
import {Arrays, Color, ValueGuide, ValueMapping} from "@opendaw/lib-std"
import {ColorSet} from "./Curves.ts"
import {IconSymbol} from "@opendaw/studio-enums"

export const ems = [7 / 6, 7 / 6, 7 / 6]
export const xAxis = new LogScale(20.0, 20_000.0)
export const yAxis = new LinearScale(-27, +27)
export const symbols = [
    IconSymbol.HighPass, IconSymbol.LowShelf,
    IconSymbol.Peak, IconSymbol.Peak, IconSymbol.Peak,
    IconSymbol.HighShelf, IconSymbol.LowPass
]
// Must be at least twice the highest frequency (nyquist), but the higher, the smoother the response.
// Although at some point, we might run into float precision issues.
export const curveSampleRate = 96_000
const hue = ValueMapping.linear(10.0, 330.0)
export const ColorSets: ReadonlyArray<ColorSet> = Arrays.create(index => {
    const color = new Color(hue.y(index / 7), 90, 66)
    return {
        full: color,
        line: color.opacity(0.08),
        min: color.opacity(0.01),
        max: color.opacity(0.30)
    }
}, 7)
export const biquad = new BiquadCoeff()
export const verticalUnits = [
    20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000] as const
export const horizontalUnits = [-24, -18, -12, -6, 0, 6, 12, 18, 24]
export const decibelValueGuide: ValueGuide.Options = {
    snap: {
        snapLength: 8,
        threshold: 0.5
    }
}
export const orderValueGuide: ValueGuide.Options = {
    trackLength: 32
}