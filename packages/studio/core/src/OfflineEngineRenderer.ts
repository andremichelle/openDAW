import {Errors, int, isDefined, Option, panic, Progress, Terminator, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EngineCommands, EngineToClient, ExportStemsConfiguration, NoteSignal} from "@opendaw/studio-adapters"
import {Project} from "./project"
import {AudioWorklets} from "./AudioWorklets"
import type {SoundFont2} from "soundfont2"

interface InitializeConfig {
    sampleRate: number
    numberOfChannels: number
    processorsUrl: string
    syncStreamBuffer: SharedArrayBuffer
    controlFlagsBuffer: SharedArrayBuffer
    project: ArrayBufferLike
    exportConfiguration?: ExportStemsConfiguration
}

interface RenderConfig {
    silenceThresholdDb?: number
    silenceDurationSeconds?: number
    maxDurationSeconds?: number
}

interface OfflineEngineProtocol {
    initialize(enginePort: MessagePort, progressPort: MessagePort, config: InitializeConfig): Promise<void>
    render(config: RenderConfig): Promise<Float32Array[]>
    step(samples: number): Promise<Float32Array[]>
    stop(): void
}

export namespace OfflineEngineRenderer {
    let workerUrl: Option<string> = Option.None

    export const install = (url: string): void => {
        console.debug(`OfflineEngineWorkerUrl: '${url}'`)
        workerUrl = Option.wrap(url)
    }

    export const getWorkerUrl = (): string => {
        return workerUrl.unwrap("OfflineEngineWorkerUrl is missing (call 'install' first)")
    }

    export const start = async (source: Project,
                                optExportConfiguration: Option<ExportStemsConfiguration>,
                                progress: Progress.Handler,
                                abortSignal?: AbortSignal,
                                sampleRate: int = 48_000): Promise<AudioData> => {
        const numStems = ExportStemsConfiguration.countStems(optExportConfiguration)
        if (numStems === 0) {return panic("Nothing to export")}
        const numberOfChannels = numStems * 2
        const {promise, reject, resolve} = Promise.withResolvers<AudioData>()

        const worker = new Worker(getWorkerUrl(), {type: "module"})
        const messenger = Messenger.for(worker)
        const protocol = Communicator.sender<OfflineEngineProtocol>(
            messenger.channel("offline-engine"),
            dispatcher => new class implements OfflineEngineProtocol {
                initialize(enginePort: MessagePort, progressPort: MessagePort, config: InitializeConfig): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.initialize, enginePort, progressPort, config)
                }
                render(config: RenderConfig): Promise<Float32Array[]> {
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
        const syncStreamBuffer = new SharedArrayBuffer(1024)
        const controlFlagsBuffer = new SharedArrayBuffer(4)

        const terminator = new Terminator()
        const projectCopy = source.copy()
        const {timelineBox, boxGraph} = projectCopy
        boxGraph.beginTransaction()
        timelineBox.loopArea.enabled.setValue(false)
        boxGraph.endTransaction()

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

        let cancelled = false

        if (isDefined(abortSignal)) {
            abortSignal.onabort = () => {
                engineCommands.stop(true)
                protocol.stop()
                terminator.terminate()
                worker.terminate()
                cancelled = true
                reject(Errors.AbortError)
            }
        }

        progressChannel.port2.onmessage = (event: MessageEvent<{
            frames: number
        }>) => progress(event.data.frames / sampleRate)

        await protocol.initialize(channel.port1, progressChannel.port1, {
            sampleRate,
            numberOfChannels,
            processorsUrl: AudioWorklets.processorsUrl,
            syncStreamBuffer,
            controlFlagsBuffer,
            project: projectCopy.toArrayBuffer(),
            exportConfiguration: optExportConfiguration.unwrapOrUndefined()
        })

        engineCommands.play()

        protocol.render({}).then(channels => {
            if (cancelled) {return}
            terminator.terminate()
            worker.terminate()
            const numberOfFrames = channels[0].length
            const audioData = AudioData.create(sampleRate, numberOfFrames, numberOfChannels)
            for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex++) {
                audioData.frames[channelIndex].set(channels[channelIndex])
            }
            resolve(audioData)
        }).catch(reason => {
            if (!cancelled) {
                terminator.terminate()
                worker.terminate()
                reject(reason)
            }
        })

        return promise
    }
}
