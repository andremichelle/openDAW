import {SampleLoaderManager, SoundfontLoaderManager} from "@opendaw/studio-adapters"
import {Editing, Func} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
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