import {isDefined, Nullable, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import type {Engine} from "../../Engine"
import {MonitoringMode, MonitorPort} from "../MonitorPort"

// what a monitor taps from an open input
export type MonitorChain = {
    readonly sourceNode: AudioNode
    readonly monitorMixdown: AudioNode
    readonly channelCount: 1 | 2
}

export class BrowserMonitor implements MonitorPort {
    readonly #context: AudioContext
    readonly #engine: Engine
    readonly #uuid: UUID.Bytes
    readonly #gainNode: GainNode
    readonly #panNode: StereoPannerNode

    #mode: MonitoringMode = "off"
    #volumeDb: number = 0.0
    #pan: number = 0.0
    #muted: boolean = false
    #chain: Nullable<MonitorChain> = null
    #outputDeviceId: Option<string> = Option.None
    #audioElement: Nullable<HTMLAudioElement> = null
    #streamDestination: Nullable<MediaStreamAudioDestinationNode> = null

    constructor(context: AudioContext, engine: Engine, uuid: UUID.Bytes) {
        this.#context = context
        this.#engine = engine
        this.#uuid = uuid
        this.#gainNode = context.createGain()
        this.#gainNode.gain.value = dbToGain(this.#volumeDb)
        this.#panNode = context.createStereoPanner()
        this.#panNode.pan.value = this.#pan
        this.#gainNode.connect(this.#panNode)
    }

    get gainNode(): GainNode {return this.#gainNode}
    get panNode(): StereoPannerNode {return this.#panNode}

    get mode(): MonitoringMode {return this.#mode}
    set mode(value: MonitoringMode) {
        if (this.#mode === value) {return}
        this.#disconnect()
        this.#mode = value
        this.#connect()
    }
    get volumeDb(): number {return this.#volumeDb}
    set volumeDb(value: number) {
        this.#volumeDb = value
        this.#gainNode.gain.value = this.#muted ? 0 : dbToGain(this.#volumeDb)
    }
    get pan(): number {return this.#pan}
    set pan(value: number) {
        this.#pan = value
        this.#panNode.pan.value = value
    }
    get muted(): boolean {return this.#muted}
    set muted(value: boolean) {
        this.#muted = value
        this.#gainNode.gain.value = value ? 0 : dbToGain(this.#volumeDb)
    }
    get outputDeviceId(): Option<string> {return this.#outputDeviceId}

    async setOutputDevice(deviceId: Option<string>): Promise<void> {
        const oldDestination = this.#destination()
        this.#outputDeviceId = deviceId
        if (isDefined(this.#audioElement)) {
            this.#audioElement.pause()
            this.#audioElement.srcObject = null
            this.#audioElement = null
        }
        if (isDefined(this.#streamDestination)) {
            this.#streamDestination.disconnect()
            this.#streamDestination = null
        }
        if (deviceId.nonEmpty()) {
            const streamDestination = this.#context.createMediaStreamDestination()
            this.#streamDestination = streamDestination
            const audio = new Audio()
            audio.srcObject = streamDestination.stream
            const played = await audio.setSinkId(deviceId.unwrap()).then(() => audio.play()).then(() => true, reason => {
                audio.srcObject = null
                streamDestination.disconnect()
                this.#streamDestination = null
                this.#outputDeviceId = Option.None
                console.warn(reason)
                RuntimeNotifier.notify({message: "Output device error.", icon: "Warning"})
                return false
            })
            if (!played) {return}
            this.#audioElement = audio
        }
        if (this.#mode !== "off" && isDefined(this.#chain)) {
            this.#panNode.disconnect(oldDestination)
            this.#panNode.connect(this.#destination())
        }
    }

    // the input opened or was rebuilt
    bind(chain: MonitorChain): void {
        this.#chain = chain
        this.#connect()
    }

    // the input is about to close or be rebuilt
    unbind(): void {
        this.#disconnect()
        this.#chain = null
    }

    terminate(): void {
        if (isDefined(this.#audioElement)) {
            this.#audioElement.pause()
            this.#audioElement.srcObject = null
        }
        this.#gainNode.disconnect()
        this.#panNode.disconnect()
    }

    #destination(): AudioNode {return this.#streamDestination ?? this.#context.destination}

    #connect(): void {
        if (!isDefined(this.#chain)) {return}
        const {sourceNode, monitorMixdown, channelCount} = this.#chain
        switch (this.#mode) {
            case "off":
                break
            case "direct":
                sourceNode.connect(this.#gainNode)
                this.#panNode.connect(this.#destination())
                break
            case "effects":
                this.#engine.registerMonitoringSource(this.#uuid, monitorMixdown, channelCount, this.#gainNode)
                this.#panNode.connect(this.#destination())
                break
        }
    }

    #disconnect(): void {
        if (!isDefined(this.#chain)) {return}
        switch (this.#mode) {
            case "off":
                break
            case "direct":
                this.#chain.sourceNode.disconnect(this.#gainNode)
                this.#panNode.disconnect(this.#destination())
                break
            case "effects":
                this.#engine.unregisterMonitoringSource(this.#uuid)
                this.#panNode.disconnect(this.#destination())
                break
        }
    }
}
