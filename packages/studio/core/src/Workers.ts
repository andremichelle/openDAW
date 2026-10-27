import {assert, FloatArray, int, Lazy, Option, Procedure} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import type {OpfsProtocol, SamplePeakProtocol} from "@opendaw/lib-fusion"
import type {
    AudioData,
    AudioMaterialFeatures,
    AudioMaterialProtocol,
    BpmProtocol,
    TransientProtocol
} from "@opendaw/lib-dsp"

const OpfsAnswerWarnMillis = 10_000

const watchOpfs = <T>(operation: string, path: string, promise: Promise<T>): Promise<T> => {
    const start = performance.now()
    const seconds = () => ((performance.now() - start) / 1000).toFixed(1)
    const warning = setTimeout(() =>
        console.warn(`[OPFS] ${operation} '${path}' has no answer from the worker after ${seconds()}s`), OpfsAnswerWarnMillis)
    const settle = () => {
        clearTimeout(warning)
        if (performance.now() - start >= OpfsAnswerWarnMillis) {
            console.warn(`[OPFS] ${operation} '${path}' answered after ${seconds()}s`)
        }
    }
    promise.then(settle, settle)
    return promise
}

export class Workers {
    static async install(url: string): Promise<void> {
        console.debug("install Workers")
        assert(this.messenger.isEmpty(), "Workers are already installed")
        const message = Messenger.for(new Worker(url, {type: "module"}))
        this.messenger = Option.wrap(message)
        const {resolve, promise} = Promise.withResolvers<void>()
        const subscription = message.channel("initialize").subscribe(data => {
            if (data === "ready") {
                console.debug("Workers ready")
                resolve()
                subscription.terminate()
            }
        })
        return promise
    }

    static messenger: Option<Messenger> = Option.None

    @Lazy
    static get Peak(): SamplePeakProtocol {
        return Communicator
            .sender<SamplePeakProtocol>(this.messenger.unwrap("Workers are not installed").channel("peaks"),
                router => new class implements SamplePeakProtocol {
                    async generateAsync(
                        progress: Procedure<number>,
                        shifts: Uint8Array,
                        frames: ReadonlyArray<FloatArray>,
                        numFrames: int,
                        numChannels: int): Promise<ArrayBufferLike> {
                        return router.dispatchAndReturn(this.generateAsync, progress, shifts, frames, numFrames, numChannels)
                    }
                })
    }

    @Lazy
    static get Opfs(): OpfsProtocol {
        return Communicator
            .sender<OpfsProtocol>(this.messenger.unwrap("Workers are not installed").channel("opfs"),
                router => new class implements OpfsProtocol {
                    write(path: string, data: Uint8Array): Promise<void> {return watchOpfs("write", path, router.dispatchAndReturn(this.write, path, data))}
                    read(path: string): Promise<Uint8Array> {return watchOpfs("read", path, router.dispatchAndReturn(this.read, path))}
                    exists(path: string): Promise<boolean> {return watchOpfs("exists", path, router.dispatchAndReturn(this.exists, path))}
                    delete(path: string): Promise<void> {return watchOpfs("delete", path, router.dispatchAndReturn(this.delete, path))}
                    list(path: string): Promise<ReadonlyArray<OpfsProtocol.Entry>> {return watchOpfs("list", path, router.dispatchAndReturn(this.list, path))}
                    isAvailable(): Promise<boolean> {return watchOpfs("isAvailable", "", router.dispatchAndReturn(this.isAvailable))}
                })
    }

    @Lazy
    static get Transients(): TransientProtocol {
        return Communicator
            .sender<TransientProtocol>(this.messenger.unwrap("Workers are not installed").channel("transients"),
                router => new class implements TransientProtocol {
                    detect(audioData: AudioData): Promise<Array<number>> {return router.dispatchAndReturn(this.detect, audioData)}
                })
    }

    @Lazy
    static get Material(): AudioMaterialProtocol {
        return Communicator
            .sender<AudioMaterialProtocol>(this.messenger.unwrap("Workers are not installed").channel("material"),
                router => new class implements AudioMaterialProtocol {
                    analyze(audioData: AudioData, moduleUrl: string): Promise<AudioMaterialFeatures> {
                        return router.dispatchAndReturn(this.analyze, audioData, moduleUrl)
                    }
                })
    }

    @Lazy
    static get Bpm(): BpmProtocol {
        return Communicator
            .sender<BpmProtocol>(this.messenger.unwrap("Workers are not installed").channel("bpm"),
                router => new class implements BpmProtocol {
                    detect(audioData: AudioData, moduleUrl: string): Promise<number> {
                        return router.dispatchAndReturn(this.detect, audioData, moduleUrl)
                    }
                })
    }
}