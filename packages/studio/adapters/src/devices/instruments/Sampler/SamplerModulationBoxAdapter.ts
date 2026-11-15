import {SamplerModulationBox} from "@opendaw/studio-boxes"
import {UUID} from "@opendaw/lib-std"
import {Address, Int32Field} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {IndexedBoxAdapter} from "../../../IndexedBoxAdapterCollection"
import {SamplerModulation} from "./SamplerModulation"

export class SamplerModulationBoxAdapter implements IndexedBoxAdapter {
    readonly #box: SamplerModulationBox

    constructor(_context: BoxAdaptersContext, box: SamplerModulationBox) {
        this.#box = box
    }

    get box(): SamplerModulationBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get source(): SamplerModulation.Source {return this.#box.source.getValue()}
    get target(): SamplerModulation.Target {return this.#box.target.getValue()}

    terminate(): void {}
}
