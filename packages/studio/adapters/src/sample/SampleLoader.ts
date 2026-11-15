import {EmptyExec, Func, isDefined, Observer, Option, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {SampleLoaderState} from "./SampleLoaderState"
import {SampleMetaData} from "./SampleMetaData"
import {AudioData, AudioInfo, PcmData} from "@opendaw/lib-dsp"

export type AudioLease = Terminable & { readonly data: AudioData }

// "while-used" keeps frames only while leased and reads them back from storage when asked again
export type SampleRetention = "always" | "while-used"

export interface SampleLoader {
    // filled once loaded, under "while-used" only while leased
    get data(): Option<AudioData>
    get peaks(): Option<Peaks>
    get uuid(): UUID.Bytes
    // The metadata of the loaded sample, tempo included. Exposed here so callers can read it synchronously
    // from the copy already in memory instead of going back to storage for a value the loader is holding.
    get meta(): Option<SampleMetaData>
    get state(): SampleLoaderState
    invalidate(): void
    subscribe(observer: Observer<SampleLoaderState>): Subscription
    // optional so that a loader written before they existed still is one, read them through the namespace
    readonly info?: Option<AudioInfo>
    acquire?(): Promise<AudioLease>
    // the frames as stored, for the engine
    pcm?(): Promise<PcmData>
}

export namespace SampleLoader {
    export const loaded = (loader: SampleLoader): Promise<void> => {
        const {promise, resolve, reject} = Promise.withResolvers<void>()
        const subscription: Subscription = loader.subscribe(state => {
            if (state.type === "loaded") {
                queueMicrotask(() => subscription.terminate())
                resolve()
            } else if (state.type === "error") {
                queueMicrotask(() => subscription.terminate())
                reject(new Error(state.reason))
            }
        })
        return promise
    }

    // the frames until the lease is terminated
    export const acquire = async (loader: SampleLoader): Promise<AudioLease> => {
        if (isDefined(loader.acquire)) {return loader.acquire()}
        await loaded(loader)
        return {data: loader.data.unwrap("The loader holds no data"), terminate: EmptyExec}
    }

    // leases for the run of `user`, also when it fails
    export const use = async <T>(loader: SampleLoader, user: Func<AudioData, T | Promise<T>>): Promise<T> => {
        const {data, terminate} = await acquire(loader)
        return Promise.resolve(data).then(user).finally(terminate)
    }

    export const frames = (loader: SampleLoader): Promise<AudioData> => use(loader, audio => audio)

    export const infoOf = (loader: SampleLoader): Option<AudioInfo> => isDefined(loader.info) ? loader.info : loader.data

    export const stored = (loader: SampleLoader): Promise<PcmData> =>
        isDefined(loader.pcm) ? loader.pcm() : frames(loader).then(audio => ({format: "float32", ...audio}))
}
