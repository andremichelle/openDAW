import {CubedPatternBox} from "@opendaw/studio-boxes"
import {Address, Int32Field} from "@opendaw/lib-box"
import {int, UUID} from "@opendaw/lib-std"
import {IndexedBoxAdapter} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"

export type CubedStep = {
    note: int      // 0..12 within one octave; octave -1/0/+1; slide carries the tie
    octave: int
    active: boolean
    slide: boolean
    accent: boolean
}

export class CubedPatternBoxAdapter implements IndexedBoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: CubedPatternBox

    constructor(context: BoxAdaptersContext, box: CubedPatternBox) {
        this.#context = context
        this.#box = box
    }

    get box(): CubedPatternBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}

    get length(): int {return this.#box.length.getValue()}
    set length(value: int) {this.#box.length.setValue(value)}

    getStep(index: int): CubedStep {return CubedPatternBoxAdapter.unpack(this.#box.steps.fields()[index].getValue())}
    setStep(index: int, step: CubedStep): void {this.#box.steps.fields()[index].setValue(CubedPatternBoxAdapter.pack(step))}

    stepToMidi(index: int, base: int): int {
        const step = this.getStep(index)
        return base + step.note + 12 * step.octave
    }

    terminate(): void {}

    // one int32 per step: note 0..3, octave 4..5 (stored 0/1/2 for -1/0/+1), active 6, slide 7, accent 8
    static pack(step: CubedStep): int {
        return (step.note & 0xF)
            | (((step.octave + 1) & 0x3) << 4)
            | ((step.active ? 1 : 0) << 6)
            | ((step.slide ? 1 : 0) << 7)
            | ((step.accent ? 1 : 0) << 8)
    }

    static unpack(bits: int): CubedStep {
        return {
            note: bits & 0xF,
            octave: ((bits >> 4) & 0x3) - 1,
            active: ((bits >> 6) & 1) === 1,
            slide: ((bits >> 7) & 1) === 1,
            accent: ((bits >> 8) & 1) === 1
        }
    }
}
