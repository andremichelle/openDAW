import {MutableObservableOption, Observer, Option, Subscription, Terminable} from "@opendaw/lib-std"
import type {CaptureAudio} from "./CaptureAudio"
import {WebAudioInputs} from "./WebAudioInputs"

// Where audio inputs come from: the browser (getUserMedia and the Web Audio graph, the default) or a host
// with its own engine (the desktop app). CaptureAudio and the UI only talk to this.
export interface AudioInputs {
    // the device list needs the user's permission first (browser)
    readonly requiresPermission: boolean
    devices(): ReadonlyArray<AudioInputs.Device>
    requestPermission(): Promise<void>
    connect(capture: CaptureAudio): AudioInputs.Connection
}

export namespace AudioInputs {
    export type Device = { readonly deviceId: string, readonly label: string }

    // One capture's input: opened while armed, with its monitoring and recording
    export interface Connection extends Terminable {
        // opens the input for the capture's device and channels, or keeps the open one
        update(): Promise<void>
        stop(): void
        channelsChanged(): void
        gainChanged(): void
        connectMonitoring(): void
        disconnectMonitoring(): void
        monitorLevelsChanged(): void
        setMonitorOutputDevice(deviceId: Option<string>): Promise<void>
        prepareRecording(): Promise<void>
        startRecording(): Terminable
        // linear peaks per channel after the gain; an empty array when the input stops
        subscribePeaks(observer: Observer<Float32Array>): Subscription
        readonly stream: MutableObservableOption<MediaStream>
        readonly streamDeviceId: Option<string>
        readonly label: string
        readonly deviceLabel: Option<string>
        readonly streamMediaTrack: Option<MediaStreamTrack>
        readonly outputNode: Option<AudioNode>
        readonly effectiveChannelCount: number
        readonly monitorGainNode: GainNode
        readonly monitorPanNode: StereoPannerNode
        readonly monitorOutputDeviceId: Option<string>
    }

    const state: { strategy: Option<AudioInputs> } = {strategy: Option.None}

    export const install = (strategy: AudioInputs): void => {state.strategy = Option.wrap(strategy)}
    export const current = (): AudioInputs => state.strategy.unwrapOrElse(WebAudioInputs)
}
