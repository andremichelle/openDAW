// A HEADLESS render through the real TypeScript studio engine (`EngineProcessor`), for TS-vs-wasm comparison.
// No browser / AudioContext: the `worklet-env` shim installs the `AudioWorkletProcessor` / `sampleRate` globals,
// a node MessageChannel carries the engine's channels, and samples are served IN-MEMORY over the `engine-to-client`
// `fetchAudio` protocol from a pre-decoded map. Mirrors `OfflineEngineRenderer` minus the Worker. Returns the
// interleaved-planar (L|R per quantum) master output plus its rms / peak.
import {setupWorkletGlobals, updateFrameTime, type WorkletGlobals} from "../../../../studio/core-workers/src/worklet-env"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Arrays, type Nullable, SyncStream, UUID} from "@opendaw/lib-std"
import {AudioData, type ppqn, RenderQuantum, WavFile} from "@opendaw/lib-dsp"
import {type EngineCommands, type EngineState, EngineStateSchema, type EngineToClient, type MonitoringMapEntry, type NoteSignal} from "@opendaw/studio-adapters"

const globals = globalThis as unknown as WorkletGlobals

export const buildSampleMap = (samples: ReadonlyArray<{uuid: UUID.Bytes, wav: ArrayBuffer}>): Map<string, AudioData> => {
    const map = new Map<string, AudioData>()
    for (const {uuid, wav} of samples) {map.set(UUID.toString(uuid), WavFile.decodeFloats(wav))}
    return map
}

export type TsRender = {rms: number, peak: number, buffer: Float32Array}

// Optional in-memory soundfont provider: raw .sf2 bytes per uuid, parsed on demand for `fetchSoundfont`.
export const renderTs = async (project: ArrayBuffer, sampleMap: Map<string, AudioData>, quanta: number,
                               soundfonts?: ReadonlyArray<{uuid: UUID.Bytes, sf2: ArrayBuffer}>): Promise<TsRender> => {
    const sampleRate = 48000
    setupWorkletGlobals({sampleRate})
    const {MessageChannel} = await import("node:worker_threads")
    const channel = new MessageChannel()
    globals.__workletPort__ = channel.port1 as unknown as MessagePort // the processor's `this.port`
    const reader = SyncStream.reader<EngineState>(EngineStateSchema(), () => {})
    const messenger = Messenger.for(channel.port2 as unknown as MessagePort)
    // The in-memory sample provider (+ the rest of EngineToClient, stubbed).
    Communicator.executor<EngineToClient>(messenger.channel("engine-to-client"), {
        log: (): void => {}, error: (): void => {}, ready: (): void => {}, deviceMessage: (): void => {},
        fetchAudio: (uuid: UUID.Bytes): Promise<AudioData> => {
            const data = sampleMap.get(UUID.toString(uuid))
            return data !== undefined ? Promise.resolve(data) : Promise.reject(new Error("missing sample"))
        },
        fetchSoundfont: async (uuid: UUID.Bytes) => {
            const carried = soundfonts?.find(entry => UUID.toString(entry.uuid) === UUID.toString(uuid))
            if (carried === undefined) {return Promise.reject(new Error("no soundfont"))}
            const {parseSoundfont} = await import("../../src/soundfont-fetch")
            return parseSoundfont(carried.sf2)
        },
        fetchNamWasm: (): Promise<never> => Promise.reject(new Error("no nam")),
        notifyClipSequenceChanges: (): void => {}, switchMarkerState: (): void => {}
    })
    const engineCommands = Communicator.sender<EngineCommands>(messenger.channel("engine-commands"),
        dispatcher => new class implements EngineCommands {
            play(): void {dispatcher.dispatchAndForget(this.play)}
            stop(reset: boolean): void {dispatcher.dispatchAndForget(this.stop, reset)}
            setPosition(position: ppqn): void {dispatcher.dispatchAndForget(this.setPosition, position)}
            prepareRecordingState(countIn: boolean): void {dispatcher.dispatchAndForget(this.prepareRecordingState, countIn)}
            stopRecording(): void {dispatcher.dispatchAndForget(this.stopRecording)}
            queryLoadingComplete(): Promise<boolean> {return dispatcher.dispatchAndReturn(this.queryLoadingComplete)}
            panic(): void {dispatcher.dispatchAndForget(this.panic)}
            noteSignal(signal: NoteSignal): void {dispatcher.dispatchAndForget(this.noteSignal, signal)}
            ignoreNoteRegion(uuid: UUID.Bytes): void {dispatcher.dispatchAndForget(this.ignoreNoteRegion, uuid)}
            scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void {dispatcher.dispatchAndForget(this.scheduleClipPlay, clipIds)}
            scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void {dispatcher.dispatchAndForget(this.scheduleClipStop, trackIds)}
            setupMIDI(port: MessagePort, buffer: SharedArrayBuffer): void {dispatcher.dispatchAndForget(this.setupMIDI, port, buffer)}
            updateMonitoringMap(map: ReadonlyArray<MonitoringMapEntry>): void {dispatcher.dispatchAndForget(this.updateMonitoringMap, map)}
            loadClickSound(index: 0 | 1, data: AudioData): void {dispatcher.dispatchAndForget(this.loadClickSound, index, data)}
            setFrozenAudio(uuid: UUID.Bytes, audioData: Nullable<AudioData>): void {dispatcher.dispatchAndForget(this.setFrozenAudio, uuid, audioData)}
            terminate(): void {dispatcher.dispatchAndForget(this.terminate)}
        })
    channel.port2.start()
    // Instantiate the engine processor ONLY AFTER the worklet globals exist (the class extends the shim base).
    const {EngineProcessor} = await import("../../../../studio/core-processors/src/EngineProcessor")
    const processor = new EngineProcessor({
        processorOptions: {
            syncStreamBuffer: reader.buffer,
            controlFlagsBuffer: new SharedArrayBuffer(4), // index 0 = sleep flag; 0 = render
            hrClockBuffer: new SharedArrayBuffer(32),
            project,
            exportConfiguration: undefined // single stereo master out
        }
    })
    // Let the async fetchAudio resolve + the loaders populate, then confirm loading is complete.
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await engineCommands.queryLoadingComplete()) {break}
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    engineCommands.play()
    await new Promise(resolve => setTimeout(resolve, 10)) // let the play() message arrive before rendering
    const half = RenderQuantum
    const buffer = new Float32Array(quanta * half * 2)
    let totalFrames = 0, sum = 0, peak = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        const outputs: Float32Array[][] = [Arrays.create(() => new Float32Array(RenderQuantum), 2)]
        updateFrameTime(totalFrames, sampleRate)
        processor.process([[]], outputs)
        totalFrames += RenderQuantum
        buffer.set(outputs[0][0], q * half * 2)
        buffer.set(outputs[0][1], q * half * 2 + half)
        for (let channel = 0; channel < 2; channel++) {
            for (let i = 0; i < RenderQuantum; i++) {
                const value = outputs[0][channel][i]
                sum += value * value
                peak = Math.max(peak, Math.abs(value))
                count++
            }
        }
    }
    return {rms: Math.sqrt(sum / count), peak, buffer}
}
