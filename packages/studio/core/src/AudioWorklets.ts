import {asDefined, int, Option} from "@opendaw/lib-std"
import {ExportStemsConfiguration, ProcessorOptions, RingBuffer} from "@opendaw/studio-adapters"
import {Project} from "./project"
import {EngineWorklet} from "./EngineWorklet"
import {MeterWorklet} from "./MeterWorklet"
import {RecordingWorklet} from "./RecordingWorklet"
import {RenderQuantum} from "./RenderQuantum"

export class AudioWorklets {
    static install(url: string): void {
        console.debug(`WorkletUrl: '${url}'`)
        this.#workletUrl = Option.wrap(url)
    }

    static get processorsUrl(): string {
        return this.#workletUrl.unwrap("WorkletUrl is missing (call 'install' first)")
    }

    static #workletUrl: Option<string> = Option.None

    static async createFor(context: BaseAudioContext): Promise<AudioWorklets> {
        return context.audioWorklet.addModule(this.#workletUrl.unwrap("WorkletUrl is missing (call 'install' first)")).then(() => {
            const worklets = new AudioWorklets(context)
            this.#map.set(context, worklets)
            return worklets
        })
    }

    static get(context: BaseAudioContext): AudioWorklets {return asDefined(this.#map.get(context), "Worklets not installed")}

    static #map: WeakMap<BaseAudioContext, AudioWorklets> = new WeakMap<AudioContext, AudioWorklets>()

    readonly #context: BaseAudioContext

    constructor(context: BaseAudioContext) {this.#context = context}

    get context(): BaseAudioContext {return this.#context}

    createMeter(numberOfChannels: int): MeterWorklet {
        return new MeterWorklet(this.#context, numberOfChannels)
    }

    createEngine({project, exportConfiguration, options}: {
        project: Project,
        exportConfiguration?: ExportStemsConfiguration,
        options?: ProcessorOptions
    }): EngineWorklet {
        return new EngineWorklet(this.#context, project, exportConfiguration, options)
    }

    createRecording(numberOfChannels: int, numChunks: int): RecordingWorklet {
        const audioBytes = numberOfChannels * numChunks * RenderQuantum * Float32Array.BYTES_PER_ELEMENT
        const pointerBytes = Int32Array.BYTES_PER_ELEMENT * 2
        const sab = new SharedArrayBuffer(audioBytes + pointerBytes)
        const buffer: RingBuffer.Config = {sab, numChunks, numberOfChannels, bufferSize: RenderQuantum}
        return new RecordingWorklet(this.#context, buffer)
    }
}