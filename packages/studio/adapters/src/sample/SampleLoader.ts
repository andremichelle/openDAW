import {EmptyExec, Func, isDefined, Observer, Option, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {SampleLoaderState} from "./SampleLoaderState"
import {SampleMetaData} from "./SampleMetaData"
import {AudioData, AudioInfo, PcmData} from "@opendaw/lib-dsp"

// The frames of a sample, kept in memory until the lease is terminated.
export type AudioLease = Terminable & { readonly data: AudioData }

export interface SampleLoader {
    // The frames while the loader holds them: always once loaded, or only while leased (see SampleRetention).
    get data(): Option<AudioData>
    // Sample rate, frame count and channel count, filled once the sample is loaded.
    get info(): Option<AudioInfo>
    get peaks(): Option<Peaks>
    get uuid(): UUID.Bytes
    // The metadata of the loaded sample, tempo included. Exposed here so callers can read it synchronously
    // from the copy already in memory instead of going back to storage for a value the loader is holding.
    get meta(): Option<SampleMetaData>
    get state(): SampleLoaderState
    invalidate(): void
    subscribe(observer: Observer<SampleLoaderState>): Subscription
    // Waits for the sample and hands out its frames. Rejects when the sample cannot be loaded.
    acquire(): Promise<AudioLease>
    // The frames in the format they are stored in, for the engine. Absent: the engine gets the floats.
    pcm?(): Promise<PcmData>
}

// "while-used" keeps frames only while leased and reads them back from storage when asked again
export type SampleRetention = "always" | "while-used"

export namespace SampleLoader {
    // a loader written before `acquire` existed keeps its data once loaded
    const lease = async (loader: SampleLoader): Promise<AudioLease> => {
        if (isDefined(loader.acquire)) {return loader.acquire()}
        await loaded(loader)
        return {data: loader.data.unwrap("The loader holds no data"), terminate: EmptyExec}
    }

    // leases the frames for the run of `user`, also when it fails
    export const use = async <T>(loader: SampleLoader, user: Func<AudioData, T | Promise<T>>): Promise<T> => {
        const {data, terminate} = await lease(loader)
        return Promise.resolve(data).then(user).finally(terminate)
    }

    // the frames, held by whoever keeps the result
    export const frames = (loader: SampleLoader): Promise<AudioData> => use(loader, audio => audio)

    // a loader written before `info` existed answers with its data
    export const infoOf = (loader: SampleLoader): Option<AudioInfo> => isDefined(loader.info) ? loader.info : loader.data

    // what the engine is given: the frames as stored where the loader knows them, else its floats
    export const stored = (loader: SampleLoader): Promise<PcmData> =>
        isDefined(loader.pcm) ? loader.pcm() : frames(loader).then(audio => ({format: "float32", ...audio}))

    // resolves once the sample is loaded, rejects when it failed
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
}
