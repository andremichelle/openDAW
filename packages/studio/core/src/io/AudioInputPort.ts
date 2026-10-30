import {Func, MutableObservableOption, Option, Provider, Terminable} from "@opendaw/lib-std"
import {MonitorPort} from "./MonitorPort"
import {RecordingLatency} from "./RecordingLatency"
import {RecordingSink} from "./RecordingSink"

// what a capture asks its input for, none while it wants no input (disarmed or gone)
export type AudioInputRequest = { readonly deviceId: Option<string>, readonly channels: Option<1 | 2> }

// the Web Audio side of an open input, for the getters CaptureAudio keeps for SDK users
export interface AudioInputNodes {
    get stream(): MutableObservableOption<MediaStream>
    get streamMediaTrack(): Option<MediaStreamTrack>
    get outputNode(): Option<AudioNode>
    get monitorGainNode(): GainNode
    get monitorPanNode(): StereoPannerNode
}

export interface AudioInputPort extends Terminable {
    get monitor(): MonitorPort
    get nodes(): Option<AudioInputNodes>
    get deviceId(): Option<string>
    get label(): Option<string>
    // 1 while nothing is open
    get channelCount(): 1 | 2
    set gainDb(value: number)
    // opens what the capture asks for, keeps the open input when it still serves the request
    open(): Promise<void>
    // the open input with the channel count the capture asks for now
    rechannel(): void
    close(): void
    // `open` is the caller's sequenced open of the input the recording needs
    prepareRecording(open: Func<void, Promise<void>>): Promise<void>
    takeRecording(): Option<RecordingSink>
    readLatency(resolveInput: (outputLatency: number) => number): Provider<RecordingLatency>
}
