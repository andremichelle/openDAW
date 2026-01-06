import {isDefined, Nullable} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {setupWorkletGlobals, updateFrameTime} from "./worklet-env"

export interface OfflineEngineProtocol {
    initialize(enginePort: MessagePort,
               progressPort: MessagePort,
               config: {
                   sampleRate: number
                   numberOfChannels: number
                   processorsUrl: string
                   syncStreamBuffer: SharedArrayBuffer
                   controlFlagsBuffer: SharedArrayBuffer
                   project: ArrayBufferLike
               }): Promise<void>
    render(config: {
        silenceThresholdDb?: number
        silenceDurationSeconds?: number
        maxDurationSeconds?: number
    }): Promise<Float32Array[]>
    step(samples: number): Promise<Float32Array[]>
    stop(): void
}

let processor: any = null
let progressPort: Nullable<MessagePort> = null
let sampleRate = 48000
let running = false
let totalFrames = 0
let remainder: Float32Array[] = [new Float32Array(0), new Float32Array(0)]

Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self).channel("offline-engine"),
    {
        async initialize(enginePort, progressPortParameter, config) {
            sampleRate = config.sampleRate
            progressPort = progressPortParameter
            totalFrames = 0
            remainder = [new Float32Array(0), new Float32Array(0)]
            setupWorkletGlobals({sampleRate})
            ;(globalThis as any).__workletPort__ = enginePort
            await import(config.processorsUrl)
            const ProcessorClass = (globalThis as any).__registeredProcessors__["engine-processor"]
            processor = new ProcessorClass({
                processorOptions: {
                    syncStreamBuffer: config.syncStreamBuffer,
                    controlFlagsBuffer: config.controlFlagsBuffer,
                    project: config.project
                }
            })
        },

        async step(samples: number): Promise<Float32Array[]> {
            const result: Float32Array[] = [new Float32Array(samples), new Float32Array(samples)]
            let offset = 0
            if (remainder[0].length > 0) {
                const fromRemainder = Math.min(remainder[0].length, samples)
                result[0].set(remainder[0].subarray(0, fromRemainder), 0)
                result[1].set(remainder[1].subarray(0, fromRemainder), 0)
                remainder[0] = remainder[0].subarray(fromRemainder)
                remainder[1] = remainder[1].subarray(fromRemainder)
                offset = fromRemainder
            }
            while (offset < samples) {
                const outputs: Float32Array[][] = [[new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]]
                updateFrameTime(totalFrames, sampleRate)
                processor.process([[]], outputs)
                totalFrames += RenderQuantum
                const needed = samples - offset
                if (needed >= RenderQuantum) {
                    result[0].set(outputs[0][0], offset)
                    result[1].set(outputs[0][1], offset)
                    offset += RenderQuantum
                } else {
                    result[0].set(outputs[0][0].subarray(0, needed), offset)
                    result[1].set(outputs[0][1].subarray(0, needed), offset)
                    remainder[0] = outputs[0][0].slice(needed)
                    remainder[1] = outputs[0][1].slice(needed)
                    offset += needed
                }
            }
            return result
        },

        async render(config) {
            const {silenceThresholdDb, silenceDurationSeconds, maxDurationSeconds} = config
            const threshold = Math.pow(10, (silenceThresholdDb ?? -60) / 20)
            const silenceFramesNeeded = Math.ceil((silenceDurationSeconds ?? 2) * sampleRate)
            const maxFrames = maxDurationSeconds !== undefined ? Math.ceil(maxDurationSeconds * sampleRate) : Infinity
            const chunks: Float32Array[][] = [[], []]
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            running = true
            let lastYield = 0

            await new Promise(r => setTimeout(r, 0))

            while (running && totalFrames < maxFrames) {
                const outputs: Float32Array[][] = [[new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]]
                updateFrameTime(totalFrames, sampleRate)
                const keepRunning = processor.process([[]], outputs)
                let maxSample = 0
                for (const channel of outputs[0]) {
                    for (const sample of channel) {
                        const abs = Math.abs(sample)
                        if (abs > maxSample) maxSample = abs
                    }
                }
                const isSilent = maxSample <= threshold
                if (maxSample > threshold) {hasHadAudio = true}
                if (isSilent && hasHadAudio) {
                    consecutiveSilentFrames += RenderQuantum
                    if (consecutiveSilentFrames >= silenceFramesNeeded) {break}
                } else {
                    consecutiveSilentFrames = 0
                }
                chunks[0].push(outputs[0][0].slice())
                chunks[1].push(outputs[0][1].slice())
                totalFrames += RenderQuantum
                if (!keepRunning) {break}
                if (totalFrames - lastYield >= sampleRate) {
                    lastYield = totalFrames
                    if (isDefined(progressPort)) {
                        progressPort.postMessage({frames: totalFrames})
                    }
                    await new Promise(r => setTimeout(r, 0))
                }
            }
            const framesToKeep = totalFrames - consecutiveSilentFrames + Math.min(sampleRate / 4, consecutiveSilentFrames)
            return [0, 1].map(ch => {
                const total = new Float32Array(framesToKeep)
                let offset = 0
                for (const chunk of chunks[ch]) {
                    if (offset >= framesToKeep) break
                    const toCopy = Math.min(chunk.length, framesToKeep - offset)
                    total.set(chunk.subarray(0, toCopy), offset)
                    offset += toCopy
                }
                return total
            })
        },

        stop() { running = false }
    }
)