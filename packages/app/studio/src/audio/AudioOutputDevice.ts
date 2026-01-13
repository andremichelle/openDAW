import {asDefined, DefaultObservableValue, Option, Strings} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {AudioDevices} from "@/audio/AudioDevices"

export class AudioOutputDevice {
    static async create(context: AudioContext): Promise<AudioOutputDevice> {
        return new AudioOutputDevice(context)
    }

    readonly #context: AudioContext
    readonly #switchable: boolean
    readonly #value: DefaultObservableValue<Option<MediaDeviceInfo>>

    private constructor(context: AudioContext) {
        this.#context = context
        this.#context.addEventListener("sinkchange", async () => {
            const {status, value} = await Promises.tryCatch(this.resolveOutput())
            this.#value.setValue(status === "resolved" ? Option.wrap(value) : Option.None)
            console.debug(`New Device: ${status === "resolved" ? value.label : ""}`)
        })
        this.#switchable = "setSinkId" in AudioContext.prototype && "sinkId" in AudioContext.prototype
        this.#value = new DefaultObservableValue<Option<MediaDeviceInfo>>(Option.None)
    }

    get value(): DefaultObservableValue<Option<MediaDeviceInfo>> {return this.#value}

    get switchable(): boolean {return this.#switchable}

    async setOutput(device: MediaDeviceInfo) {
        if (!this.#switchable || device.deviceId === "default") {return}
        const {status} = await Promises.tryCatch(this.#context.setSinkId(device.deviceId))
        console.debug("AudioContext.setSinkId", status)
    }

    async resolveOutput(): Promise<MediaDeviceInfo> {
        const sinkId = this.#resolveSinkId()
        return AudioDevices.queryListOutputDevices()
            .then((devices) => asDefined(devices
                    .find(device => device.deviceId === sinkId),
                `Could not find output device with sinkId: '${sinkId}'`))
    }

    #resolveSinkId(): string {
        const sinkId = this.#context.sinkId
        return typeof sinkId === "string" ? Strings.nonEmpty(sinkId, "default") : "default"
    }
}