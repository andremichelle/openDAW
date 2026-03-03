import {int, Unhandled} from "@opendaw/lib-std"

// https://www.desmos.com/calculator/04tpdtpkfy
export namespace Waveshaper {
    export type Equation = "hardclip" | "cubicSoft" | "tanh" | "sigmoid" | "arctan" | "asymmetric"

    export const process = (audio: [Float32Array, Float32Array], equation: Equation, fromIndex: int, toIndex: int): void => {
        const [l, r] = audio
        const {sign, exp, abs, atan, tanh, PI} = Math
        const TWO_OVER_PI = 2.0 / PI
        switch (equation) {
            case "hardclip":
                for (let i = fromIndex; i < toIndex; i++) {
                    l[i] = l[i] < -1.0 ? -1.0 : l[i] > 1.0 ? 1.0 : l[i]
                    r[i] = r[i] < -1.0 ? -1.0 : r[i] > 1.0 ? 1.0 : r[i]
                }
                return
            case "cubicSoft":
                for (let i = fromIndex; i < toIndex; i++) {
                    const lx = l[i] < -1.0 ? -1.0 : l[i] > 1.0 ? 1.0 : l[i]
                    const rx = r[i] < -1.0 ? -1.0 : r[i] > 1.0 ? 1.0 : r[i]
                    l[i] = (3.0 * lx - lx * lx * lx) * 0.5
                    r[i] = (3.0 * rx - rx * rx * rx) * 0.5
                }
                return
            case "tanh":
                for (let i = fromIndex; i < toIndex; i++) {
                    l[i] = tanh(l[i])
                    r[i] = tanh(r[i])
                }
                return
            case "sigmoid":
                for (let i = fromIndex; i < toIndex; i++) {
                    l[i] = sign(l[i]) * (1.0 - exp(-abs(l[i])))
                    r[i] = sign(r[i]) * (1.0 - exp(-abs(r[i])))
                }
                return
            case "arctan":
                for (let i = fromIndex; i < toIndex; i++) {
                    l[i] = TWO_OVER_PI * atan(l[i])
                    r[i] = TWO_OVER_PI * atan(r[i])
                }
                return
            case "asymmetric":
                for (let i = fromIndex; i < toIndex; i++) {
                    l[i] = l[i] < 0.0 ? l[i] : l[i] / (1.0 + l[i])
                    r[i] = r[i] < 0.0 ? r[i] : r[i] / (1.0 + r[i])
                }
                return
            default:
                return Unhandled(equation)
        }
    }
}