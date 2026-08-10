import {Observer, Option, Subscription, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {SampleLoaderState} from "./SampleLoaderState"
import {SampleMetaData} from "./SampleMetaData"
import {AudioData} from "@opendaw/lib-dsp"

export interface SampleLoader {
    get data(): Option<AudioData>
    get peaks(): Option<Peaks>
    get uuid(): UUID.Bytes
    // The metadata of the loaded sample, tempo included. Exposed here so callers can read it synchronously
    // from the copy already in memory instead of going back to storage for a value the loader is holding.
    get meta(): Option<SampleMetaData>
    get state(): SampleLoaderState
    invalidate(): void
    subscribe(observer: Observer<SampleLoaderState>): Subscription
}