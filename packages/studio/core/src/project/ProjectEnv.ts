import {SampleLoaderManager, SoundfontLoaderManager} from "@opendaw/studio-adapters"
import {Editing, Func} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioWorklets} from "../AudioWorklets"

export interface ProjectEnv {
    audioContext: AudioContext
    audioWorklets: AudioWorklets
    sampleManager: SampleLoaderManager
    soundfontManager: SoundfontLoaderManager
    createEditing?: Func<BoxGraph, Editing>
}