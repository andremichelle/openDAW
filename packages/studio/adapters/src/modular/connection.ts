import {ModuleConnectionBox} from "@moises-ai/studio-boxes"
import {Address, Vertex} from "@moises-ai/lib-box"
import {BoxAdapter} from "../BoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"

export class ModuleConnectionAdapter implements BoxAdapter {
    readonly #box: ModuleConnectionBox

    constructor(_context: BoxAdaptersContext, box: ModuleConnectionBox) {
        this.#box = box
    }

    get box(): ModuleConnectionBox {return this.#box}
    get uuid(): Readonly<Uint8Array> {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get source(): Vertex {return this.#box.source.targetVertex.unwrap("Insufficient Vertex")}
    get target(): Vertex {return this.#box.target.targetVertex.unwrap("Insufficient Vertex")}

    terminate(): void {}
}