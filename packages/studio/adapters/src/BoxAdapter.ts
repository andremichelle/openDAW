import {Terminable, UUID} from "@moises-ai/lib-std"
import {Addressable, Box} from "@moises-ai/lib-box"

export interface BoxAdapter extends Addressable, Terminable {
    get box(): Box
    get uuid(): UUID.Bytes
}