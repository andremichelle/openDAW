import {
    ArrayMultimap,
    clamp,
    DefaultObservableValue,
    EmptyExec,
    Option,
    Procedure,
    Subscription,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {OpenSampleAPI, SampleStorage, WavFile} from "@opendaw/studio-core"
import {dbToGain} from "@opendaw/lib-dsp"

export type PlaybackEvent = {
    type: "idle"
} | {
    type: "buffering"
} | {
    type: "playing"
} | {
    type: "error"
    reason: string
}

export class SamplePlayback {
    readonly #audio: HTMLAudioElement
    readonly #notifiers: ArrayMultimap<string, Procedure<PlaybackEvent>>
    readonly #linearVolume: DefaultObservableValue<unitValue>

    #current: Option<string> = Option.None

    constructor() {
        this.#audio = new Audio()
        this.#audio.crossOrigin = "use-credentials"
        this.#audio.preload = "auto"
        this.#notifiers = new ArrayMultimap<string, Procedure<PlaybackEvent>>()
        this.#linearVolume = new DefaultObservableValue<number>(0.0, {
            guard: (value: number): number => clamp(value, -36, 0)
        })
        this.#linearVolume.catchupAndSubscribe(owner => this.#audio.volume = dbToGain(owner.getValue()))
    }

    toggle(uuidAsString: string): void {
        if (this.#current.contains(uuidAsString)) {
            if (this.#audio.paused) {
                this.#notify(uuidAsString, {type: "buffering"})
                this.#audio.play().catch(EmptyExec)
            } else {
                this.#audio.currentTime = 0.0
                this.#audio.pause()
            }
        } else {
            this.#watchAudio(uuidAsString)
            this.#notify(uuidAsString, {type: "buffering"})

            SampleStorage.get().load(UUID.parse(uuidAsString))
                .then(([audio]) => {
                    this.#audio.src = URL.createObjectURL(new Blob([WavFile.encodeFloats({
                        frames: audio.frames.slice(),
                        sampleRate: audio.sampleRate,
                        numberOfFrames: audio.numberOfFrames,
                        numberOfChannels: audio.numberOfChannels
                    })], {type: "audio/wav"}))
                }, () => {
                    this.#audio.src = `${OpenSampleAPI.FileRoot}/${uuidAsString}`
                })
                .finally(() => this.#audio.play().catch(EmptyExec))

            this.#current.ifSome(uuid => this.#notify(uuid, {type: "idle"}))
            this.#current = Option.wrap(uuidAsString)
        }
    }

    eject(): void {
        this.#current.ifSome(uuid => this.#notify(uuid, {type: "idle"}))
        this.#current = Option.None
        this.#audio.pause()
        this.#unwatchAudio()
    }

    subscribe(uuidAsString: string, procedure: Procedure<PlaybackEvent>): Subscription {
        this.#notifiers.add(uuidAsString, procedure)
        return {terminate: () => this.#notifiers.remove(uuidAsString, procedure)}
    }

    get linearVolume(): DefaultObservableValue<number> {return this.#linearVolume}

    #notify(uuidAsString: string, event: PlaybackEvent): void {
        this.#notifiers.get(uuidAsString).forEach(procedure => procedure(event))
    }

    #watchAudio(uuidAsString: string): void {
        this.#audio.onended = () => this.#notify(uuidAsString, {type: "idle"})
        this.#audio.ontimeupdate = () => {
            if (!this.#audio.paused && this.#audio.duration > 0.0) {this.#notify(uuidAsString, {type: "playing"})}
        }
        this.#audio.onpause = () => this.#notify(uuidAsString, {type: "idle"})
        this.#audio.onstalled = () => this.#notify(uuidAsString, {type: "buffering"})
        this.#audio.onerror = (event, _source, _lineno, _colno, error) => this.#notify(uuidAsString, {
            type: "error",
            reason: error?.message ?? event instanceof Event ? "Unknown" : event
        })
    }

    #unwatchAudio(): void {
        this.#audio.onended = null
        this.#audio.onplay = null
        this.#audio.onpause = null
        this.#audio.onerror = null
        this.#audio.onstalled = null
        this.#audio.ontimeupdate = null
    }
}