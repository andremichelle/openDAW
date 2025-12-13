import {Provider} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"

export type AudioOutputInfo = {
    readonly address: Address
    readonly path: Provider<ReadonlyArray<string>>
}
