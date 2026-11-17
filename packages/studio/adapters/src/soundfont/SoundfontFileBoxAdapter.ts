import {SoundfontFileBox} from "@opendaw/studio-boxes"
import {Option, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {SoundfontLoader} from "./SoundfontLoader"
import type {SoundfontBank} from "./SoundfontBank"

export class SoundfontFileBoxAdapter implements BoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: SoundfontFileBox

    constructor(context: BoxAdaptersContext, box: SoundfontFileBox) {
        this.#context = context
        this.#box = box
    }

    get box(): SoundfontFileBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get soundfont(): Option<SoundfontBank.Bank> {return this.getOrCreateLoader().soundfont}

    getOrCreateLoader(): SoundfontLoader {
        return this.#context.soundfontManager.getOrCreate(this.#box.address.uuid)
    }

    terminate(): void {}
}