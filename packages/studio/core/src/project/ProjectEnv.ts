import {SampleLoaderManager, SoundfontLoaderManager} from "@moises-ai/studio-adapters"
import {AudioWorklets} from "../AudioWorklets"

export interface ProjectEnv {
    audioContext: AudioContext
    audioWorklets: AudioWorklets
    sampleManager: SampleLoaderManager
    soundfontManager: SoundfontLoaderManager
}