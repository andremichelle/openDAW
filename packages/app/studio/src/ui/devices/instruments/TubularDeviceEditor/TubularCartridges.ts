import {asDefined, Lazy, Option, panic} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Dx7Sysex, Dx7Voice} from "@opendaw/studio-adapters"

// The bundled DX7 cartridges (public/tubular): the index lists each cartridge's name and credits, every
// .syx is fetched and decoded once (37 × 4 KB), so the menus can build synchronously from `loaded`.
export type TubularCartridge = {
    readonly name: string
    readonly file: string
    readonly author: string
    readonly license: string
    readonly credit?: string
    readonly source: string
    readonly voices: ReadonlyArray<Dx7Voice>
}

type IndexEntry = Omit<TubularCartridge, "voices">

export class TubularCartridges {
    static readonly Root = "/tubular"

    @Lazy
    static get(): TubularCartridges {return new TubularCartridges()}

    readonly #load: () => Promise<ReadonlyArray<TubularCartridge>>
    #loaded: Option<ReadonlyArray<TubularCartridge>> = Option.None

    private constructor() {
        this.#load = Promises.memoizeAsync(async () => {
            const json = await fetch(`${TubularCartridges.Root}/index.json`)
                .then(response => response.ok ? response.json() : panic(`${response.status} ${response.statusText}`))
            const entries = asDefined(json.cartridges, "index without cartridges") as ReadonlyArray<IndexEntry>
            const cartridges = await Promise.all(entries.map(async entry => {
                const buffer = await fetch(`${TubularCartridges.Root}/cartridges/${entry.file}`)
                    .then(response => response.ok ? response.arrayBuffer() : panic(`${response.status} ${response.statusText}`))
                return {...entry, voices: Dx7Sysex.decode(new Uint8Array(buffer))}
            }))
            this.#loaded = Option.wrap(cartridges)
            return cartridges
        })
    }

    load(): Promise<ReadonlyArray<TubularCartridge>> {return this.#load()}

    get loaded(): Option<ReadonlyArray<TubularCartridge>> {return this.#loaded}
}
