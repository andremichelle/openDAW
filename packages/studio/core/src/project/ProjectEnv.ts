import {SampleLoaderManager, SoundfontLoaderManager} from "@moises-ai/studio-adapters"
import {Editing, Func} from "@moises-ai/lib-std"
import {BoxGraph} from "@moises-ai/lib-box"
import {AudioWorklets} from "../AudioWorklets"
import {SampleService} from "../samples"
import {SoundfontService} from "../soundfont"

export interface ProjectEnv {
    audioContext: AudioContext
    audioWorklets: AudioWorklets
    sampleManager: SampleLoaderManager
    soundfontManager: SoundfontLoaderManager
    sampleService: SampleService
    soundfontService: SoundfontService
    createEditing?: Func<BoxGraph, Editing>
}