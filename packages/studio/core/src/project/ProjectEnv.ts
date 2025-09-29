import {SampleLoaderManager} from "@opendaw/studio-adapters"
import {AudioWorklets} from "../AudioWorklets"

export interface ProjectEnv {
    audioContext: AudioContext
    audioWorklets: AudioWorklets
    sampleManager: SampleLoaderManager
}