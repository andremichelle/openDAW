import {Option, Progress, UUID} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {AudioData} from "@moises-ai/lib-dsp"
import {SampleMetaData} from "@moises-ai/studio-adapters"
import {type Fetcher} from "./ChainedProvider"

type SampleResult = [AudioData, SampleMetaData]
export type SampleFetcher = Fetcher<SampleResult>

export class ChainedSampleProvider implements SampleFetcher {
    readonly #cloud: SampleFetcher

    #peer: Option<SampleFetcher> = Option.None

    constructor(cloud: SampleFetcher) {
        this.#cloud = cloud
    }

    attachPeer(provider: SampleFetcher): void {this.#peer = Option.wrap(provider)}
    detachPeer(): void {this.#peer = Option.None}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<SampleResult> {
        const result = await Promises.tryCatch(this.#cloud.fetch(uuid, progress))
        if (result.status === "resolved") {return result.value}
        return this.#peer.match({
            none: () => {throw result.error},
            some: peer => peer.fetch(uuid, progress)
        })
    }
}
