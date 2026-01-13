import {SoundfontFileBox} from "@moises-ai/studio-boxes"
import {Option, UUID} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {SoundfontLoader} from "./SoundfontLoader"
import type {SoundFont2} from "soundfont2"

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
    get soundfont(): Option<SoundFont2> {return this.getOrCreateLoader().soundfont}

    getOrCreateLoader(): SoundfontLoader {
        return this.#context.soundfontManager.getOrCreate(this.#box.address.uuid)
    }

    terminate(): void {}
}