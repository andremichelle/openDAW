import {Option, SortedSet, Terminable} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AudioOutputInfo} from "./AudioOutputInfo"

export class AudioOutputInfoRegistry {
    readonly #outputs: SortedSet<Address, AudioOutputInfo>

    constructor() {
        this.#outputs = Address.newSet<AudioOutputInfo>(({address}) => address)
    }

    register(info: AudioOutputInfo): Terminable {
        this.#outputs.add(info)
        return {terminate: () => this.#outputs.removeByKey(info.address)}
    }

    list(): ReadonlyArray<AudioOutputInfo> {
        return this.#outputs.values()
    }

    query(address: Address): Option<AudioOutputInfo> {
        return this.#outputs.opt(address)
    }
}
