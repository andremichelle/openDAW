import {
    AudioData,
    Chord,
    ClassicWaveform,
    dbToGain,
    FFT,
    gainToDb,
    Interpolation,
    midiToHz,
    Mixing,
    PPQN
} from "@opendaw/lib-dsp"
import {AudioSendRouting, TransientPlayMode, VoicingMode} from "@opendaw/studio-enums"
import {ScriptHostProtocol} from "./ScriptHostProtocol"
import {ScriptExecutionContext} from "./ScriptExecutionProtocol"
import {Api} from "./Api"
import {ApiImpl} from "./impl/ApiImpl"

export namespace ScriptGlobals {
    export const create = (api: Api, context: ScriptExecutionContext): Record<string, unknown> => ({
        ...context,
        openDAW: api,
        AudioData, midiToHz, PPQN, FFT, Chord, Interpolation, dbToGain, gainToDb,
        ClassicWaveform, VoicingMode, Mixing, TransientPlayMode, AudioSendRouting
    })
}

export class ScriptRunner {
    readonly #api: Api

    constructor(protocol: ScriptHostProtocol) {this.#api = new ApiImpl(protocol)}

    get api(): Api {return this.#api}

    async run(jsCode: string, context: ScriptExecutionContext): Promise<void> {
        Object.assign(globalThis, ScriptGlobals.create(this.#api, context))
        const blob = new Blob([jsCode], {type: "text/javascript"})
        const url = URL.createObjectURL(blob)
        try {
            const AsyncFunction = (async () => {}).constructor as new (arg: string, body: string) =>
                (...args: any[]) => Promise<any>
            await new AsyncFunction("url", "return import(url)")(url)
        } finally {
            URL.revokeObjectURL(url)
        }
    }
}
