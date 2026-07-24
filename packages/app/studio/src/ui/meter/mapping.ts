import {dbToGain, gainToDb} from "@opendaw/lib-dsp"
import {clampUnit, unitValue, ValueMapping} from "@opendaw/lib-std"

export class GainMapping implements ValueMapping<number> {
    readonly #max: number
    readonly #bend: number

    constructor(maxDb: number, bend: number = 1.0) {
        this.#max = dbToGain(maxDb)
        this.#bend = bend
    }

    x(y: number): unitValue {return Math.pow(clampUnit(dbToGain(y) / this.#max), 1.0 / this.#bend)}
    y(x: unitValue): number {return gainToDb(Math.pow(x, this.#bend) * this.#max)}
    clamp(y: number): number {return y}
    floating(): boolean {return true}
}