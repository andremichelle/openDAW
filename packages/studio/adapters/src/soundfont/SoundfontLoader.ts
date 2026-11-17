import {Observer, Option, Subscription, UUID} from "@opendaw/lib-std"
import type {SoundfontBank} from "./SoundfontBank"
import {SoundfontLoaderState} from "./SoundfontLoaderState"

export interface SoundfontLoader {
    get soundfont(): Option<SoundfontBank.Bank>
    get uuid(): UUID.Bytes
    get state(): SoundfontLoaderState
    subscribe(observer: Observer<SoundfontLoaderState>): Subscription
    invalidate(): void
}