import {dbToGain, gainToDb} from "@moises-ai/lib-dsp"
import {unitValue, ValueMapping} from "@moises-ai/lib-std"

export class GainMapping implements ValueMapping<number> {
    private readonly linear: ValueMapping<number>
    private readonly bend: number

    constructor(maxDb: number, bend: number = 1.0) {
        this.linear = ValueMapping.linear(0.0, dbToGain(maxDb))
        this.bend = bend
    }

    x(y: number): unitValue {return Math.pow(this.linear.x(dbToGain(y)), 1.0 / this.bend)}
    y(x: unitValue): number {return gainToDb(this.linear.y(Math.pow(x, this.bend)))}
    clamp(y: number): number {return y}
    floating(): boolean {return true}
}