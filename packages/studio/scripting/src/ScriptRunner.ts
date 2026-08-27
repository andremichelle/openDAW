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
        // Runs as a function body, not a module, so a script may `return` early
        const AsyncFunction = (async () => {}).constructor as new (body: string) => () => Promise<void>
        await new AsyncFunction(jsCode.replace(/^\s*export\s*\{\s*\};?/m, ""))()
    }
}
