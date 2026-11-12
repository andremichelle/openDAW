import {SamplerGroupBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {UUID} from "@opendaw/lib-std"
import {Address, Int32Field} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {IndexedBoxAdapter, IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {SamplerZoneBoxAdapter} from "./SamplerZoneBoxAdapter"

export class SamplerGroupBoxAdapter implements IndexedBoxAdapter {
    static readonly RoundRobinNames: ReadonlyArray<string> = ["Off", "Cycle", "Random"]
    static readonly TriggerNames: ReadonlyArray<string> = ["Attack", "Release"]

    readonly #box: SamplerGroupBox
    readonly #zones: IndexedBoxAdapterCollection<SamplerZoneBoxAdapter, Pointers.SamplerGroupZone>

    constructor(context: BoxAdaptersContext, box: SamplerGroupBox) {
        this.#box = box
        this.#zones = IndexedBoxAdapterCollection.create(box.zones,
            box => context.boxAdapters.adapterFor(box, SamplerZoneBoxAdapter), Pointers.SamplerGroupZone)
    }

    get box(): SamplerGroupBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get zones(): IndexedBoxAdapterCollection<SamplerZoneBoxAdapter, Pointers.SamplerGroupZone> {return this.#zones}

    terminate(): void {this.#zones.terminate()}
}
