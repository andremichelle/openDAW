import {Terminable} from "@moises-ai/lib-std"

export interface DeviceChain extends Terminable {
    invalidateWiring(): void
}