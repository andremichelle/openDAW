import {ExportStemConfiguration} from "@opendaw/studio-adapters"

export type AudioUnitOptions = Omit<ExportStemConfiguration, "fileName">

export namespace AudioUnitOptions {
    export const Default: AudioUnitOptions = {
        includeAudioEffects: true,
        includeSends: true,
        useInstrumentOutput: false
    }
}