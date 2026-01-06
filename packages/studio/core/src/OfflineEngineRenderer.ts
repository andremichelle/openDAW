import {isDefined, Option, Terminator, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EngineCommands, EngineToClient, NoteSignal} from "@opendaw/studio-adapters"
import {Project} from "./project"
import {AudioWorklets} from "./AudioWorklets"
import type {SoundFont2} from "soundfont2"

interface OfflineEngineProtocol {
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

export class OfflineEngineRenderer {
    static #workerUrl: Option<string> = Option.None

    static install(url: string): void {
        console.debug(`OfflineEngineWorkerUrl: '${url}'`)
        this.#workerUrl = Option.wrap(url)
    }

    static get workerUrl(): string {
        return this.#workerUrl.unwrap("OfflineEngineWorkerUrl is missing (call 'install' first)")
    }

    static async create(project: Project, sampleRate = 48000): Promise<OfflineEngineRenderer> {
        const worker = new Worker(this.workerUrl, {type: "module"})
        const messenger = Messenger.for(worker)
        const protocol = Communicator.sender<OfflineEngineProtocol>(
            messenger.channel("offline-engine"),
            dispatcher => new class implements OfflineEngineProtocol {
                initialize(enginePort: MessagePort, progressPort: MessagePort, config: any): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.initialize, enginePort, progressPort, config)
                }
                render(config: any): Promise<Float32Array[]> { return dispatcher.dispatchAndReturn(this.render, config) }
                step(samples: number): Promise<Float32Array[]> { return dispatcher.dispatchAndReturn(this.step, samples) }
                stop(): void { dispatcher.dispatchAndForget(this.stop) }
            }
        )

        const channel = new MessageChannel()
        const progressChannel = new MessageChannel()
        const syncStreamBuffer = new SharedArrayBuffer(1024)
        const controlFlagsBuffer = new SharedArrayBuffer(4)

        const engineMessenger = Messenger.for(channel.port2)
        Communicator.executor<EngineToClient>(engineMessenger.channel("engine-to-client"), {
            log: (message: string): void => console.log("OFFLINE-ENGINE", message),
            error: (reason: unknown) => console.error("OFFLINE-ENGINE", reason),
            ready: (): void => {},
            fetchAudio: (uuid: UUID.Bytes): Promise<AudioData> => {
                return new Promise((resolve, reject) => {
                    const handler = project.sampleManager.getOrCreate(uuid)
                    const subscription = handler.subscribe(state => {
                        if (state.type === "error") {
                            reject(new Error(state.reason))
                            subscription.terminate()
                        } else if (state.type === "loaded") {
                            resolve(handler.data.unwrap())
                            subscription.terminate()
                        }
                    })
                })
            },
            fetchSoundfont: (uuid: UUID.Bytes): Promise<SoundFont2> => {
                return new Promise((resolve, reject) => {
                    const handler = project.soundfontManager.getOrCreate(uuid)
                    const subscription = handler.subscribe(state => {
                        if (state.type === "error") {
                            reject(new Error(state.reason))
                            subscription.terminate()
                        } else if (state.type === "loaded") {
                            resolve(handler.soundfont.unwrap())
                            subscription.terminate()
                        }
                    })
                })
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
                terminate(): void { dispatcher.dispatchAndForget(this.terminate) }
            }
        )
        channel.port2.start()
        progressChannel.port2.start()
        await protocol.initialize(channel.port1, progressChannel.port1, {
            sampleRate,
            numberOfChannels: 2,
            processorsUrl: AudioWorklets.processorsUrl,
            syncStreamBuffer,
            controlFlagsBuffer,
            project: project.toArrayBuffer()
        })
        return new OfflineEngineRenderer(worker, protocol, sampleRate, progressChannel.port2, engineCommands)
    }

    readonly #terminator = new Terminator()

    readonly #worker: Worker
    readonly #protocol: OfflineEngineProtocol
    readonly #sampleRate: number
    readonly #progressPort: MessagePort
    readonly #engineCommands: EngineCommands

    private constructor(worker: Worker,
                        protocol: OfflineEngineProtocol,
                        sampleRate: number,
                        progressPort: MessagePort,
                        engineCommands: EngineCommands) {
        this.#worker = worker
        this.#protocol = protocol
        this.#sampleRate = sampleRate
        this.#progressPort = progressPort
        this.#engineCommands = engineCommands
    }

    get sampleRate(): number { return this.#sampleRate }

    async step(durationMs: number): Promise<Float32Array[]> {
        const samples = Math.ceil((durationMs / 1000) * this.#sampleRate)
        return this.#protocol.step(samples)
    }

    async render(options: {
        silenceThresholdDb?: number
        silenceDurationSeconds?: number
        maxDurationSeconds?: number
        onProgress?: (seconds: number) => void
    } = {}): Promise<Float32Array[]> {
        const {onProgress, ...config} = options
        if (isDefined(onProgress)) {
            this.#progressPort.onmessage = (event: MessageEvent<{ frames: number }>) => {
                onProgress(event.data.frames / this.#sampleRate)
            }
        }
        this.#engineCommands.play()
        try {
            return await this.#protocol.render(config)
        } finally {
            this.#engineCommands.stop(true)
            this.#progressPort.onmessage = null
        }
    }

    stop(): void { this.#protocol.stop() }

    terminate(): void {
        this.#terminator.terminate()
        this.#worker.terminate()
    }
}