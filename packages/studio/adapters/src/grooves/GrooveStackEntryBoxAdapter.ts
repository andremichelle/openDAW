import {Address, Int32Field} from "@opendaw/lib-box"
import {GrooveStackEntryBox} from "@opendaw/studio-boxes"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {IndexedBoxAdapter} from "../IndexedBoxAdapterCollection"
import {GrooveAdapter} from "./GrooveBoxAdapter"

export class GrooveStackEntryBoxAdapter implements IndexedBoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: GrooveStackEntryBox

    constructor(context: BoxAdaptersContext, box: GrooveStackEntryBox) {
        this.#context = context
        this.#box = box
    }

    get box(): GrooveStackEntryBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}

    groove(): Option<GrooveAdapter> {
        return this.#box.groove.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, GrooveAdapter.checkType))
    }

    terminate(): void {}
}
