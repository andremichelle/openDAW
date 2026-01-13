import {Observer, Option, Subscription, UUID} from "@moises-ai/lib-std"
import type {SoundFont2} from "soundfont2"
import {SoundfontLoaderState} from "./SoundfontLoaderState"

export interface SoundfontLoader {
    get soundfont(): Option<SoundFont2>
    get uuid(): UUID.Bytes
    get state(): SoundfontLoaderState
    subscribe(observer: Observer<SoundfontLoaderState>): Subscription
    invalidate(): void
}