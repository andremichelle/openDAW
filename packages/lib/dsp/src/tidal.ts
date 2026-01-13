import {linear, unitValue} from "@moises-ai/lib-std"

export class TidalComputer {
    static readonly #SLOPE_MULT: number = 10.0

    #depth: number = 1.0
    #slope: number = 0.0
    #symmetry: number = 0.0

    #pEx: number = 0.0
    #invS0: number = 0.0
    #invS1: number = 0.0

    set(depth: number, slope: number, symmetry: number): void {
        this.#depth = depth
        this.#slope = slope * TidalComputer.#SLOPE_MULT
        this.#symmetry = linear(1e-5, 1.0 - 1e-5, symmetry)

        this.#pEx = 2.0 ** Math.abs(this.#slope)
        this.#invS0 = 1.0 / this.#symmetry
        this.#invS1 = 1.0 / (1.0 - this.#symmetry)
    }

    compute(input: unitValue): unitValue {
        const p = input - Math.floor(input)

        let x: number
        let sym: number
        let invS0: number
        let invS1: number
        if (this.#slope < 0.0) {
            x = 1.0 - p
            sym = 1.0 - this.#symmetry
            invS0 = this.#invS1
            invS1 = this.#invS0
        } else {
            x = p
            sym = this.#symmetry
            invS0 = this.#invS0
            invS1 = this.#invS1
        }
        if (x <= sym) {
            return 1.0 - ((1.0 - x * invS0) ** this.#pEx) * this.#depth
        } else {
            return (((1.0 - x) * invS1) ** this.#pEx) * this.#depth - this.#depth + 1.0
        }
    }
}