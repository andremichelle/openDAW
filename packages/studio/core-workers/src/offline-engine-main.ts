import {Arrays, int, isDefined, Option, TimeSpan} from "@opendaw/lib-std"
import {Communicator, Messenger, Wait} from "@opendaw/lib-runtime"
import {dbToGain, RenderQuantum} from "@opendaw/lib-dsp"
import {OfflineEngineInitializeConfig, OfflineEngineProtocol, OfflineEngineRenderConfig} from "@opendaw/studio-adapters"
import {AudioWorkletProcessor, setupWorkletGlobals, updateFrameTime, WorkletGlobals} from "./worklet-env"

const globals = globalThis as unknown as WorkletGlobals

type EngineState = {
    readonly processor: AudioWorkletProcessor
    readonly progressPort: MessagePort
    readonly sampleRate: int
    readonly numberOfChannels: int
    totalFrames: int
    running: boolean
}

let state: Option<EngineState> = Option.None

Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self).channel("offline-engine"), {
        async initialize(enginePort: MessagePort, progressPort: MessagePort, config: OfflineEngineInitializeConfig) {
            setupWorkletGlobals({sampleRate: config.sampleRate})
            globals.__workletPort__ = enginePort
            await import(config.processorsUrl)
            const ProcessorClass = globals.__registeredProcessors__["engine-processor"]
            state = Option.wrap({
                processor: new ProcessorClass({
                    processorOptions: {
                        syncStreamBuffer: config.syncStreamBuffer,
                        controlFlagsBuffer: config.controlFlagsBuffer,
                        hrClockBuffer: new SharedArrayBuffer(32),
                        project: config.project,
                        exportConfiguration: config.exportConfiguration
                    }
                }),
                progressPort,
                sampleRate: config.sampleRate,
                numberOfChannels: config.numberOfChannels,
                totalFrames: 0,
                running: false
            })
        },
        async step(numSamples: int): Promise<Float32Array[]> {
            const engine = state.unwrap()
            const result: Float32Array[] = Arrays.create(() => new Float32Array(numSamples), engine.numberOfChannels)
            const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), engine.numberOfChannels)
            let offset = 0 | 0
            while (offset < numSamples) {
                const outputs: Float32Array[][] = [outputChannels]
                updateFrameTime(engine.totalFrames, engine.sampleRate)
                engine.processor.process([[]], outputs)
                engine.totalFrames += RenderQuantum
                const needed = numSamples - offset
                const toCopy = Math.min(needed, RenderQuantum)
                for (let ch = 0; ch < engine.numberOfChannels; ch++) {
                    result[ch].set(outputs[0][ch].subarray(0, toCopy), offset)
                }
                offset += toCopy
            }
            return result
        },
        async render(config: OfflineEngineRenderConfig) {
            const engine = state.unwrap()
            const {silenceThresholdDb, silenceDurationSeconds, maxDurationSeconds} = config
            const threshold = dbToGain(silenceThresholdDb ?? -72.0)
            const silenceFramesNeeded = Math.ceil((silenceDurationSeconds ?? 10) * engine.sampleRate)
            const maxFrames = isDefined(maxDurationSeconds) ? Math.ceil(maxDurationSeconds * engine.sampleRate) : Infinity
            const chunks: Float32Array[][] = Arrays.create(() => [], engine.numberOfChannels)
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            let lastYield = 0
            engine.running = true
            await Wait.timeSpan(TimeSpan.seconds(0))
            while (engine.running && engine.totalFrames < maxFrames) {
                const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), engine.numberOfChannels)
                const outputs: Float32Array[][] = [outputChannels]
                updateFrameTime(engine.totalFrames, engine.sampleRate)
                const keepRunning = engine.processor.process([[]], outputs)
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
                for (let ch = 0; ch < engine.numberOfChannels; ch++) {
                    chunks[ch].push(outputs[0][ch].slice())
                }
                engine.totalFrames += RenderQuantum
                if (!keepRunning) {break}
                if (engine.totalFrames - lastYield >= engine.sampleRate) {
                    lastYield = engine.totalFrames
                    engine.progressPort.postMessage({frames: engine.totalFrames})
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            }
            const framesToKeep = engine.totalFrames - consecutiveSilentFrames + Math.min(engine.sampleRate / 4, consecutiveSilentFrames)
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
            }, engine.numberOfChannels)
        },
        stop() { state.unwrap().running = false }
    }
)
