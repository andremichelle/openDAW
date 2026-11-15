import {SamplerZoneBox} from "@opendaw/studio-boxes"
import {Option, Terminator, UUID} from "@opendaw/lib-std"
import {Address, Int32Field} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {IndexedBoxAdapter} from "../../../IndexedBoxAdapterCollection"
import {AudioFileBoxAdapter} from "../../../audio/AudioFileBoxAdapter"
import {SamplerGroupBoxAdapter} from "./SamplerGroupBoxAdapter"

export class SamplerZoneBoxAdapter implements IndexedBoxAdapter {
    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: SamplerZoneBox

    #file: Option<AudioFileBoxAdapter> = Option.None

    constructor(context: BoxAdaptersContext, box: SamplerZoneBox) {
        this.#context = context
        this.#box = box
        this.#terminator.own(this.#box.file.catchupAndSubscribe(pointer => {
            this.#file = pointer.targetVertex.map(({box}) => this.#context.boxAdapters.adapterFor(box, AudioFileBoxAdapter))
            this.#file.ifSome(file => file.getOrCreateLoader())
        }))
    }

    get box(): SamplerZoneBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}

    file(): Option<AudioFileBoxAdapter> {return this.#file}

    group(): Option<SamplerGroupBoxAdapter> {
        return this.#box.group.targetVertex
            .map(({box}) => this.#context.boxAdapters.adapterFor(box, SamplerGroupBoxAdapter))
    }

    // the zone answers this key and velocity
    accepts(key: number, velocity: number): boolean {
        const {keyLow, keyHigh, velocityLow, velocityHigh} = this.#box
        return key >= keyLow.getValue() && key <= keyHigh.getValue()
            && velocity >= velocityLow.getValue() && velocity <= velocityHigh.getValue()
    }

    // on the same keys and velocities as the other zone, which makes the two round robins within a group
    sharesRange(other: SamplerZoneBoxAdapter): boolean {
        const {keyLow, keyHigh, velocityLow, velocityHigh} = this.#box
        return keyLow.getValue() === other.box.keyLow.getValue() && keyHigh.getValue() === other.box.keyHigh.getValue()
            && velocityLow.getValue() === other.box.velocityLow.getValue()
            && velocityHigh.getValue() === other.box.velocityHigh.getValue()
    }

    terminate(): void {this.#terminator.terminate()}
}
