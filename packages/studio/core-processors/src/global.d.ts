declare type ChannelCountMode = "clamped-max" | "explicit" | "max";
declare type ChannelInterpretation = "discrete" | "speakers";

declare interface AudioNodeOptions {
    channelCount?: number
    channelCountMode?: ChannelCountMode
    channelInterpretation?: ChannelInterpretation
}

declare const sampleRate: number
declare const currentTime: number