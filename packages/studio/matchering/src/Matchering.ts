import {EmptyProcedure, Procedure} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {AudioData} from "@opendaw/lib-dsp"
import type {MatcheringProtocol} from "./MatcheringProtocol"

// Reference mastering based on Matchering by Sergree (GPL-3.0), runs in its own worker that exists only per job
export namespace Matchering {
    export const SampleRate = 44100

    export type Stage = "levels" | "frequencies" | "correction"

    export type ReferenceProfile = {
        matchRms: number
        finalAmplitude: number
        midSpectrum: Float64Array
        sideSpectrum: Float64Array
    }

    export type MatchResult = {
        gain: number
        finalAmplitude: number
        midCurve: Float64Array
        sideCurve: Float64Array
    }

    const wasmUrl = (): string => new URL("../dist/matchering.wasm", import.meta.url).href

    const run = async <R>(job: (protocol: MatcheringProtocol) => Promise<R>): Promise<R> => {
        const worker = new Worker(new URL("./matchering-worker.ts", import.meta.url), {type: "module"})
        const protocol = Communicator.sender<MatcheringProtocol>(Messenger.for(worker).channel("matchering"),
            router => new class implements MatcheringProtocol {
                analyseReference(wasmUrl: string, left: Float32Array, right: Float32Array): Promise<ReferenceProfile> {
                    return router.dispatchAndReturn(this.analyseReference, wasmUrl, left, right)
                }

                matchTarget(progress: Procedure<Stage>, wasmUrl: string, left: Float32Array, right: Float32Array,
                            profile: ReferenceProfile): Promise<MatchResult> {
                    return router.dispatchAndReturn(this.matchTarget, progress, wasmUrl, left, right, profile)
                }
            })
        return job(protocol).finally(() => worker.terminate())
    }

    const stereoAt44100 = async (audio: AudioData): Promise<[Float32Array, Float32Array]> => {
        const {sampleRate, numberOfFrames, numberOfChannels, frames} = audio
        const [left, right] = [frames[0].slice(), frames[numberOfChannels > 1 ? 1 : 0].slice()]
        if (sampleRate === SampleRate) {return [left, right]}
        const length = Math.ceil(numberOfFrames * SampleRate / sampleRate)
        const context = new OfflineAudioContext(2, length, SampleRate)
        const buffer = context.createBuffer(2, numberOfFrames, sampleRate)
        buffer.copyToChannel(left, 0)
        buffer.copyToChannel(right, 1)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.start()
        const rendered = await context.startRendering()
        return [rendered.getChannelData(0), rendered.getChannelData(1)]
    }

    export const analyseReference = async (audio: AudioData): Promise<ReferenceProfile> => {
        const [left, right] = await stereoAt44100(audio)
        return run(protocol => protocol.analyseReference(wasmUrl(), left, right))
    }

    export const matchTarget = async (audio: AudioData, profile: ReferenceProfile,
                                      progress: Procedure<Stage> = EmptyProcedure): Promise<MatchResult> => {
        const [left, right] = await stereoAt44100(audio)
        return run(protocol => protocol.matchTarget(progress, wasmUrl(), left, right, profile))
    }
}
