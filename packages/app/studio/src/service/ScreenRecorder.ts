import {
    DefaultObservableValue,
    Errors,
    Exec,
    isDefined,
    ObservableValue,
    Option,
    RuntimeNotifier,
    Terminator,
    tryCatch
} from "@opendaw/lib-std"
import {Browser, Events} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {EngineFacade} from "@opendaw/studio-core"
import {ScreenRecording} from "@/service/ScreenRecording"

type TabCaptureOptions = DisplayMediaStreamOptions & {
    preferCurrentTab: boolean, selfBrowserSurface: "include", surfaceSwitching: "exclude"
}

const FrameRate = 60

export class ScreenRecorder {
    static isSupported(): boolean {
        const chromium = Browser.isChrome() || navigator.userAgent.includes("Edg/")
        return chromium && Browser.isWeb() && !Browser.isMobile()
            && isDefined(navigator.mediaDevices?.getDisplayMedia) && isDefined(window.VideoEncoder)
            && isDefined(window.AudioEncoder) && isDefined(window.MediaStreamTrackProcessor)
            && isDefined(window.showSaveFilePicker)
    }

    readonly #audioContext: AudioContext
    readonly #engine: EngineFacade
    readonly #recording: DefaultObservableValue<boolean>

    #stop: Option<Exec> = Option.None

    constructor(audioContext: AudioContext, engine: EngineFacade) {
        this.#audioContext = audioContext
        this.#engine = engine
        this.#recording = new DefaultObservableValue(false)
    }

    get recording(): ObservableValue<boolean> {return this.#recording}

    async start(): Promise<void> {
        if (this.#recording.getValue()) {return}
        const options: TabCaptureOptions = {
            video: {frameRate: {ideal: FrameRate, max: FrameRate}}, audio: false,
            preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude"
        }
        const {status, value: display, error} = await Promises.tryCatch(navigator.mediaDevices.getDisplayMedia(options))
        if (status === "rejected") {
            if (!Errors.isNotAllowed(error) && !Errors.isAbort(error)) {
                await RuntimeNotifier.info({headline: "Could not record the studio", message: String(error)})
            }
            return
        }
        const terminator = new Terminator()
        const destination = this.#audioContext.createMediaStreamDestination()
        let source: Option<AudioNode> = Option.None
        const disconnect = () => source.ifSome(node => tryCatch(() => node.disconnect(destination)))
        const connect = () => {
            disconnect()
            source = this.#engine.worklet
            source.ifSome(node => node.connect(destination))
        }
        connect()
        terminator.ownAll(this.#engine.subscribeWorkletChanged(connect), {
            terminate: () => {
                disconnect()
                display.getTracks().forEach(track => track.stop())
            }
        })
        const [videoTrack] = display.getVideoTracks()
        const [audioTrack] = destination.stream.getAudioTracks()
        const abortController = new AbortController()
        terminator.ownAll(Events.subscribe(videoTrack, "ended", () => this.stop()),
            {terminate: () => abortController.abort()})
        this.#stop = Option.wrap(() => terminator.terminate())
        this.#recording.setValue(true)
        videoTrack.contentHint = "detail"
        const {width = 0, height = 0} = videoTrack.getSettings()
        const codecs = await ScreenRecording.selectCodecs(
            width & ~1, height & ~1, FrameRate, this.#audioContext.sampleRate)
        if (codecs.isEmpty()) {
            this.stop()
            await RuntimeNotifier.info({
                headline: "Could not record the studio",
                message: `No encoder for ${width} × ${height} pixels.`
            })
            return
        }
        const recording = new ScreenRecording(videoTrack, audioTrack, codecs.unwrap(), error => {
            console.warn(error)
            this.stop()
        })
        terminator.own(recording)
        const approval = await Promises.tryCatch(RuntimeNotifier.approve({
            headline: "Studio Recording",
            message: "The red stop button at the right of the header ends the recording.",
            approveText: "Start Recording",
            abortSignal: abortController.signal
        }))
        if (approval.status === "rejected" || !approval.value || abortController.signal.aborted) {
            this.stop()
            return
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
        const picked = await Promises.tryCatch(window.showSaveFilePicker({
            suggestedName: `opendaw-recording-${stamp}.mp4`,
            types: [{description: "MP4 Video", accept: {"video/mp4": [".mp4"]}}]
        }))
        if (!this.#recording.getValue()) {return}
        if (picked.status === "rejected") {
            this.stop()
            return
        }
        const writable = await picked.value.createWritable()
        const started = await Promises.tryCatch(recording.record(writable))
        if (!this.#recording.getValue()) {return}
        if (started.status === "rejected") {
            this.stop()
            await RuntimeNotifier.info({headline: "Could not record the studio", message: String(started.error)})
            return
        }
        const finish = async () => {
            const {status, error} = await Promises.tryCatch(recording.finish())
            terminator.terminate()
            if (status === "rejected") {
                await Promises.tryCatch(writable.abort())
                await RuntimeNotifier.info({headline: "Studio recording failed", message: String(error)})
            } else {
                RuntimeNotifier.notify({message: `Studio recording saved to '${picked.value.name}'.`})
            }
        }
        this.#stop = Option.wrap(() => {finish().then()})
    }

    stop(): void {
        const stop = this.#stop
        this.#stop = Option.None
        this.#recording.setValue(false)
        stop.ifSome(exec => exec())
    }
}
