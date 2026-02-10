import {Errors, int, isDefined, Option, panic, Progress, Terminator, TimeSpan, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {Communicator, Messenger, Wait} from "@opendaw/lib-runtime"
import {
    EngineCommands,
    EngineStateSchema,
    EngineToClient,
    ExportStemsConfiguration,
    MonitoringMapEntry,
    NoteSignal,
    OfflineEngineInitializeConfig,
    OfflineEngineProtocol,
    OfflineEngineRenderConfig
} from "@opendaw/studio-adapters"
import {Project} from "./project"
import {AudioWorklets} from "./AudioWorklets"
import {MIDIReceiver} from "./midi"
import type {SoundFont2} from "soundfont2"

let workerUrl: Option<string> = Option.None

export class OfflineEngineRenderer {
    static install(url: string): void {
        console.debug(`OfflineEngineWorkerUrl: '${url}'`)
        workerUrl = Option.wrap(url)
    }

    static getWorkerUrl(): string {
        return workerUrl.unwrap("OfflineEngineWorkerUrl is missing (call 'install' first)")
    }

    static async create(source: Project,
                        optExportConfiguration: Option<ExportStemsConfiguration>,
                        sampleRate: int = 48_000
    ): Promise<OfflineEngineRenderer> {
        const numStems = ExportStemsConfiguration.countStems(optExportConfiguration)
        if (numStems === 0) {return panic("Nothing to export")}
        const numberOfChannels = numStems * 2
        const worker = new Worker(this.getWorkerUrl(), {type: "module"})
        const messenger = Messenger.for(worker)
        const protocol = Communicator.sender<OfflineEngineProtocol>(
            messenger.channel("offline-engine"),
            dispatcher => new class implements OfflineEngineProtocol {
                initialize(enginePort: MessagePort, progressPort: MessagePort, config: OfflineEngineInitializeConfig): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.initialize, enginePort, progressPort, config)
                }
                render(config: OfflineEngineRenderConfig): Promise<Float32Array[]> {
                    return dispatcher.dispatchAndReturn(this.render, config)
                }
                step(samples: number): Promise<Float32Array[]> {
                    return dispatcher.dispatchAndReturn(this.step, samples)
                }
                stop(): void { dispatcher.dispatchAndForget(this.stop) }
            }
        )
        const channel = new MessageChannel()
        const progressChannel = new MessageChannel()
        const syncStreamBuffer = new SharedArrayBuffer(EngineStateSchema().bytesTotal + 1)
        const controlFlagsBuffer = new SharedArrayBuffer(4)
        const terminator = new Terminator()
        const engineMessenger = Messenger.for(channel.port2)
        Communicator.executor<EngineToClient>(engineMessenger.channel("engine-to-client"), {
            log: (message: string): void => console.log("OFFLINE-ENGINE", message),
            error: (reason: unknown) => console.error("OFFLINE-ENGINE", reason),
            ready: (): void => {},
            fetchAudio: (uuid: UUID.Bytes): Promise<AudioData> => new Promise((resolve, reject) => {
                const handler = source.sampleManager.getOrCreate(uuid)
                const subscription = handler.subscribe(state => {
                    if (state.type === "error") {
                        reject(new Error(state.reason))
                        subscription.terminate()
                    } else if (state.type === "loaded") {
                        resolve(handler.data.unwrap())
                        subscription.terminate()
                    }
                })
            }),
            fetchSoundfont: (uuid: UUID.Bytes): Promise<SoundFont2> => new Promise((resolve, reject) => {
                const handler = source.soundfontManager.getOrCreate(uuid)
                const subscription = handler.subscribe(state => {
                    if (state.type === "error") {
                        reject(new Error(state.reason))
                        subscription.terminate()
                    } else if (state.type === "loaded") {
                        resolve(handler.soundfont.unwrap())
                        subscription.terminate()
                    }
                })
            }),
            fetchNamWasm: async (): Promise<ArrayBuffer> => {
                const url = new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)
                const response = await fetch(url)
                return response.arrayBuffer()
            },
            notifyClipSequenceChanges: (): void => {},
            switchMarkerState: (): void => {}
        })

        const engineCommands = Communicator.sender<EngineCommands>(
            engineMessenger.channel("engine-commands"),
            dispatcher => new class implements EngineCommands {
                play(): void { dispatcher.dispatchAndForget(this.play) }
                stop(reset: boolean): void { dispatcher.dispatchAndForget(this.stop, reset) }
                setPosition(position: ppqn): void { dispatcher.dispatchAndForget(this.setPosition, position) }
                prepareRecordingState(countIn: boolean): void { dispatcher.dispatchAndForget(this.prepareRecordingState, countIn) }
                stopRecording(): void { dispatcher.dispatchAndForget(this.stopRecording) }
                queryLoadingComplete(): Promise<boolean> { return dispatcher.dispatchAndReturn(this.queryLoadingComplete) }
                panic(): void { dispatcher.dispatchAndForget(this.panic) }
                noteSignal(signal: NoteSignal): void { dispatcher.dispatchAndForget(this.noteSignal, signal) }
                ignoreNoteRegion(uuid: UUID.Bytes): void { dispatcher.dispatchAndForget(this.ignoreNoteRegion, uuid) }
                scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void { dispatcher.dispatchAndForget(this.scheduleClipPlay, clipIds) }
                scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void { dispatcher.dispatchAndForget(this.scheduleClipStop, trackIds) }
                setupMIDI(port: MessagePort, buffer: SharedArrayBuffer): void { dispatcher.dispatchAndForget(this.setupMIDI, port, buffer) }
                updateMonitoringMap(map: ReadonlyArray<MonitoringMapEntry>): void { dispatcher.dispatchAndForget(this.updateMonitoringMap, map) }
                loadClickSound(index: 0 | 1, data: AudioData): void { dispatcher.dispatchAndForget(this.loadClickSound, index, data) }
                terminate(): void { dispatcher.dispatchAndForget(this.terminate) }
            }
        )

        channel.port2.start()
        progressChannel.port2.start()

        terminator.own(source.liveStreamReceiver.connect(engineMessenger.channel("engine-live-data")))

        const {port, sab} = terminator.own(MIDIReceiver.create(() => 0,
            (deviceId, data, relativeTimeInMs) => source.receivedMIDIFromEngine(deviceId, data, relativeTimeInMs)))

        await protocol.initialize(channel.port1, progressChannel.port1, {
            sampleRate,
            numberOfChannels,
            processorsUrl: AudioWorklets.processorsUrl,
            syncStreamBuffer,
            controlFlagsBuffer,
            project: source.toArrayBuffer(),
            exportConfiguration: optExportConfiguration.unwrapOrUndefined()
        })

        engineCommands.setupMIDI(port, sab)

        return new OfflineEngineRenderer(
            worker,
            protocol,
            engineCommands,
            terminator,
            progressChannel.port2,
            sampleRate,
            numberOfChannels
        )
    }

    static async start(source: Project,
                       optExportConfiguration: Option<ExportStemsConfiguration>,
                       progress: Progress.Handler,
                       abortSignal?: AbortSignal,
                       sampleRate: int = 48_000
    ): Promise<AudioData> {
        const {timelineBox: {loopArea: {enabled}}, boxGraph} = source
        const wasEnabled = enabled.getValue()
        boxGraph.beginTransaction()
        enabled.setValue(false)
        boxGraph.endTransaction()
        const renderer = await this.create(source, optExportConfiguration, sampleRate)
        const result = await renderer.render({}, progress, abortSignal)
        boxGraph.beginTransaction()
        enabled.setValue(wasEnabled)
        boxGraph.endTransaction()
        return result
    }

    readonly #worker: Worker
    readonly #protocol: OfflineEngineProtocol
    readonly #engineCommands: EngineCommands
    readonly #terminator: Terminator
    readonly #progressPort: MessagePort
    readonly #sampleRate: int
    readonly #numberOfChannels: int

    #totalFrames: int = 0

    private constructor(
        worker: Worker,
        protocol: OfflineEngineProtocol,
        engineCommands: EngineCommands,
        terminator: Terminator,
        progressPort: MessagePort,
        sampleRate: int,
        numberOfChannels: int
    ) {
        this.#worker = worker
        this.#protocol = protocol
        this.#engineCommands = engineCommands
        this.#terminator = terminator
        this.#progressPort = progressPort
        this.#sampleRate = sampleRate
        this.#numberOfChannels = numberOfChannels
    }

    get sampleRate(): int {return this.#sampleRate}
    get numberOfChannels(): int {return this.#numberOfChannels}
    get totalFrames(): int {return this.#totalFrames}

    play(): void {
        this.#engineCommands.play()
    }

    stop(): void {
        this.#engineCommands.stop(true)
        this.#protocol.stop()
    }

    setPosition(position: ppqn): void {
        this.#engineCommands.setPosition(position)
    }

    async waitForLoading(): Promise<void> {
        while (!await this.#engineCommands.queryLoadingComplete()) {
            await Wait.timeSpan(TimeSpan.millis(100))
        }
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#worker.terminate()
    }

    async step(samples: int): Promise<Float32Array[]> {
        const channels = await this.#protocol.step(samples)
        this.#totalFrames += samples
        return channels
    }

    async render(
        config: OfflineEngineRenderConfig,
        progress: Progress.Handler,
        abortSignal?: AbortSignal
    ): Promise<AudioData> {
        const {promise, reject, resolve} = Promise.withResolvers<AudioData>()
        let cancelled = false

        if (isDefined(abortSignal)) {
            abortSignal.onabort = () => {
                this.stop()
                this.terminate()
                cancelled = true
                reject(Errors.AbortError)
            }
        }

        this.#progressPort.onmessage = (event: MessageEvent<{ frames: number }>) =>
            progress(event.data.frames / this.#sampleRate)

        while (!await this.#engineCommands.queryLoadingComplete()) {
            await Wait.timeSpan(TimeSpan.millis(100))
        }
        this.play()
        this.#protocol.render(config).then(channels => {
            if (cancelled) {return}
            this.terminate()
            const numberOfFrames = channels[0].length
            const audioData = AudioData.create(this.#sampleRate, numberOfFrames, this.#numberOfChannels)
            for (let channelIndex = 0; channelIndex < this.#numberOfChannels; channelIndex++) {
                audioData.frames[channelIndex].set(channels[channelIndex])
            }
            resolve(audioData)
        }).catch(reason => {
            if (!cancelled) {
                this.terminate()
                reject(reason)
            }
        })
        return promise
    }
}
