import {RingBuffer} from "./RingBuffer"

export interface RecordingProcessorOptions extends RingBuffer.Config {}

export interface RecordingProcessorToClient {
    firstQuantum(contextTime: number): void
}

export const RecordingProcessorChannel = "recording-to-client"
