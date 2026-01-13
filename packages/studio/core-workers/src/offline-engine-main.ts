import {Arrays, isDefined, Nullable, TimeSpan} from "@moises-ai/lib-std"
import {Communicator, Messenger, Wait} from "@moises-ai/lib-runtime"
import {dbToGain, RenderQuantum} from "@moises-ai/lib-dsp"
import {OfflineEngineInitializeConfig, OfflineEngineProtocol, OfflineEngineRenderConfig} from "@moises-ai/studio-adapters"
import {setupWorkletGlobals, updateFrameTime} from "./worklet-env"

let processor: any = null
let progressPort: Nullable<MessagePort> = null
let sampleRate = 48000
let numberOfChannels = 2
let running = false
let totalFrames = 0

Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self).channel("offline-engine"), {
        async initialize(enginePort: MessagePort, progressPortParameter: MessagePort, config: OfflineEngineInitializeConfig) {
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
            const result: Float32Array[] = Arrays.create(() => new Float32Array(samples), numberOfChannels)
            const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
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
        async render(config: OfflineEngineRenderConfig) {
            const {silenceThresholdDb, silenceDurationSeconds, maxDurationSeconds} = config
            const threshold = dbToGain(silenceThresholdDb ?? -72.0)
            const silenceFramesNeeded = Math.ceil((silenceDurationSeconds ?? 10) * sampleRate)
            const maxFrames = isDefined(maxDurationSeconds) ? Math.ceil(maxDurationSeconds * sampleRate) : Infinity
            const chunks: Float32Array[][] = Arrays.create(() => [], numberOfChannels)
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            let lastYield = 0

            running = true

            await Wait.timeSpan(TimeSpan.seconds(0))

            while (running && totalFrames < maxFrames) {
                const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
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
            return Arrays.create(channelIndex => {
                const total = new Float32Array(framesToKeep)
                let offset = 0
                for (const chunk of chunks[channelIndex]) {
                    if (offset >= framesToKeep) {break}
                    const toCopy = Math.min(chunk.length, framesToKeep - offset)
                    total.set(chunk.subarray(0, toCopy), offset)
                    offset += toCopy
                }
                return total
            }, numberOfChannels)
        },
        stop() { running = false }
    }
)
