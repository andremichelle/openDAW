import {isDefined, Nullable} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {ExportStemsConfiguration} from "@opendaw/studio-adapters"
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
                   exportConfiguration?: ExportStemsConfiguration
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
let numberOfChannels = 2
let running = false
let totalFrames = 0

Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self).channel("offline-engine"),
    {
        async initialize(enginePort, progressPortParameter, config) {
            sampleRate = config.sampleRate
            numberOfChannels = config.numberOfChannels
            progressPort = progressPortParameter
            totalFrames = 0
            setupWorkletGlobals({sampleRate})
            ;(globalThis as any).__workletPort__ = enginePort
            await import(config.processorsUrl)
            const ProcessorClass = (globalThis as any).__registeredProcessors__["engine-processor"]
            processor = new ProcessorClass({
                processorOptions: {
                    syncStreamBuffer: config.syncStreamBuffer,
                    controlFlagsBuffer: config.controlFlagsBuffer,
                    project: config.project,
                    exportConfiguration: config.exportConfiguration
                }
            })
        },

        async step(samples: number): Promise<Float32Array[]> {
            const result: Float32Array[] = Array.from({length: numberOfChannels}, () => new Float32Array(samples))
            const outputChannels: Float32Array[] = Array.from({length: numberOfChannels}, () => new Float32Array(RenderQuantum))
            let offset = 0
            while (offset < samples) {
                const outputs: Float32Array[][] = [outputChannels]
                updateFrameTime(totalFrames, sampleRate)
                processor.process([[]], outputs)
                totalFrames += RenderQuantum
                const needed = samples - offset
                const toCopy = Math.min(needed, RenderQuantum)
                for (let ch = 0; ch < numberOfChannels; ch++) {
                    result[ch].set(outputs[0][ch].subarray(0, toCopy), offset)
                }
                offset += toCopy
            }
            return result
        },

        async render(config) {
            const {silenceThresholdDb, silenceDurationSeconds, maxDurationSeconds} = config
            const threshold = Math.pow(10, (silenceThresholdDb ?? -60) / 20)
            const silenceFramesNeeded = Math.ceil((silenceDurationSeconds ?? 2) * sampleRate)
            const maxFrames = isDefined(maxDurationSeconds) ? Math.ceil(maxDurationSeconds * sampleRate) : Infinity
            const chunks: Float32Array[][] = Array.from({length: numberOfChannels}, () => [])
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            running = true
            let lastYield = 0

            await new Promise(resolve => setTimeout(resolve, 0))

            while (running && totalFrames < maxFrames) {
                const outputChannels: Float32Array[] = Array.from({length: numberOfChannels}, () => new Float32Array(RenderQuantum))
                const outputs: Float32Array[][] = [outputChannels]
                updateFrameTime(totalFrames, sampleRate)
                const keepRunning = processor.process([[]], outputs)

                let maxSample = 0
                for (const channel of outputs[0]) {
                    for (const sample of channel) {
                        const absoluteValue = Math.abs(sample)
                        if (absoluteValue > maxSample) {maxSample = absoluteValue}
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

                for (let ch = 0; ch < numberOfChannels; ch++) {
                    chunks[ch].push(outputs[0][ch].slice())
                }
                totalFrames += RenderQuantum

                if (!keepRunning) {break}

                if (totalFrames - lastYield >= sampleRate) {
                    lastYield = totalFrames
                    if (isDefined(progressPort)) {
                        progressPort.postMessage({frames: totalFrames})
                    }
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            }

            const framesToKeep = totalFrames - consecutiveSilentFrames + Math.min(sampleRate / 4, consecutiveSilentFrames)
            return Array.from({length: numberOfChannels}, (_, channelIndex) => {
                const total = new Float32Array(framesToKeep)
                let offset = 0
                for (const chunk of chunks[channelIndex]) {
                    if (offset >= framesToKeep) {break}
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
