import {NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {UUID} from "@opendaw/lib-std"
import {Address, StringField} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"

export class NeuralAmpModelBoxAdapter implements BoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: NeuralAmpModelBox

    constructor(context: BoxAdaptersContext, box: NeuralAmpModelBox) {
        this.#context = context
        this.#box = box
    }

    get box(): NeuralAmpModelBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get modelField(): StringField {return this.#box.model}

    getModelJson(): string {
        return this.#box.model.getValue()
    }

    terminate(): void {}
}
