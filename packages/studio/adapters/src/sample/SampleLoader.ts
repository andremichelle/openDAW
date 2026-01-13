import {Observer, Option, Subscription, UUID} from "@moises-ai/lib-std"
import {Peaks} from "@moises-ai/lib-fusion"
import {SampleLoaderState} from "./SampleLoaderState"
import {AudioData} from "@moises-ai/lib-dsp"

export interface SampleLoader {
    get data(): Option<AudioData>
    get peaks(): Option<Peaks>
    get uuid(): UUID.Bytes
    get state(): SampleLoaderState
    invalidate(): void
    subscribe(observer: Observer<SampleLoaderState>): Subscription
}