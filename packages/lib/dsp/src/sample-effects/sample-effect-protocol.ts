import {Procedure, unitValue} from "@opendaw/lib-std"
import {AudioData} from "../audio-data"

export interface SampleEffectProtocol {
    process(progress: Procedure<unitValue>, id: string, source: AudioData, values: ReadonlyArray<number>): Promise<AudioData>
}
