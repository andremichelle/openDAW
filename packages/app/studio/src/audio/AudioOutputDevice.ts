import {asDefined, DefaultObservableValue, int, ObservableValue, Option, Optional, Strings} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioDevices} from "@/audio/AudioDevices"

export type OutputDevice = { readonly deviceId: string, readonly label: string }

// An output outside this AudioContext (the desktop app's native engine), with a selectable buffer size
export interface AudioOutputBackend {
    readonly current: ObservableValue<Option<OutputDevice>>
    readonly bufferSize: ObservableValue<int>
    readonly bufferSizes: ReadonlyArray<int>
    // defined where the card can be taken exclusively (Windows): lowest latency, other programs cannot play meanwhile
    readonly exclusive: ObservableValue<Optional<boolean>>
    devices(): ReadonlyArray<OutputDevice>
    choose(device: OutputDevice, frames: int, exclusive: boolean): void
}

export class AudioOutputDevice {
    static #backend: Option<AudioOutputBackend> = Option.None

    static install(backend: AudioOutputBackend): void {this.#backend = Option.wrap(backend)}

    static async create(context: AudioContext): Promise<AudioOutputDevice> {
        return new AudioOutputDevice(context)
    }

    readonly #context: AudioContext
    readonly #switchable: boolean
    readonly #value: DefaultObservableValue<Option<OutputDevice>>

    private constructor(context: AudioContext) {
        this.#context = context
        this.#context.addEventListener("sinkchange", async () => {
            const {status, value} = await Promises.tryCatch(this.resolveOutput())
            this.#value.setValue(status === "resolved" ? Option.wrap(value) : Option.None)
            console.debug(`New Device: ${status === "resolved" ? value.label : ""}`)
        })
        this.#switchable = "setSinkId" in AudioContext.prototype && "sinkId" in AudioContext.prototype
        this.#value = new DefaultObservableValue<Option<OutputDevice>>(Option.None)
        AudioOutputDevice.#backend.ifSome(backend => backend.current.catchupAndSubscribe(owner => this.#value.setValue(owner.getValue())))
    }

    get value(): DefaultObservableValue<Option<OutputDevice>> {return this.#value}

    get switchable(): boolean {return AudioOutputDevice.#backend.nonEmpty() || this.#switchable}

    get backend(): Option<AudioOutputBackend> {return AudioOutputDevice.#backend}

    listDevices(): Promise<ReadonlyArray<OutputDevice>> {
        return AudioOutputDevice.#backend.match({
            none: () => AudioDevices.queryListOutputDevices(),
            some: backend => Promise.resolve(backend.devices())
        })
    }

    async setOutput(device: OutputDevice) {
        if (AudioOutputDevice.#backend.nonEmpty()) {
            const backend = AudioOutputDevice.#backend.unwrap()
            return backend.choose(device, backend.bufferSize.getValue(), backend.exclusive.getValue() === true)
        }
        if (!this.#switchable || device.deviceId === "default") {return}
        const {status} = await Promises.tryCatch(this.#context.setSinkId(device.deviceId))
        console.debug("AudioContext.setSinkId", status)
    }

    async resolveOutput(): Promise<OutputDevice> {
        if (AudioOutputDevice.#backend.nonEmpty()) {
            return AudioOutputDevice.#backend.unwrap().current.getValue().unwrap("No output device")
        }
        const sinkId = this.#resolveSinkId()
        return AudioDevices.queryListOutputDevices()
            .then((devices) => asDefined(devices
                    .find(device => device.deviceId === sinkId),
                `Could not find output device with sinkId: '${sinkId}'`))
    }

    #resolveSinkId(): string {
        const sinkId = this.#context.sinkId
        return typeof sinkId === "string" ? Strings.fallback(sinkId, "default") : "default"
    }
}