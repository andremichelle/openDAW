import {CubedPatternBox} from "@opendaw/studio-boxes"
import {Address, Int32Field} from "@opendaw/lib-box"
import {int, UUID} from "@opendaw/lib-std"
import {IndexedBoxAdapter} from "../../../IndexedBoxAdapterCollection"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"

export type CubedStep = {
    note: int      // MIDI note 0..127; slide carries the tie
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

    terminate(): void {}

    // one int32 per step: midi-note 0..6, active 7, slide 8, accent 9
    static pack(step: CubedStep): int {
        return (step.note & 0x7F)
            | ((step.active ? 1 : 0) << 7)
            | ((step.slide ? 1 : 0) << 8)
            | ((step.accent ? 1 : 0) << 9)
    }

    static unpack(bits: int): CubedStep {
        return {
            note: bits & 0x7F,
            active: ((bits >> 7) & 1) === 1,
            slide: ((bits >> 8) & 1) === 1,
            accent: ((bits >> 9) & 1) === 1
        }
    }
}
