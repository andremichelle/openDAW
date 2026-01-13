import {Func, int, Option, panic} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {Dialogs} from "@/ui/components/dialogs"
import {Button} from "@/ui/components/Dialog"

export class AudioDevices {
    static #granted: Option<Promise<void>> = Option.None

    static async query<T>(query: Func<MediaDevices, T>): Promise<T> {
        if (this.#granted.isEmpty()) {
            this.#granted = Option.wrap(this.#request().catch(reason => {
                console.warn("Could not get permission to use microphone / audio devices.")
                this.#granted = Option.None
                throw reason
            }))
        }
        return this.#granted.unwrap().then(() => query(navigator.mediaDevices))
    }

    static async queryListInputDevices(): Promise<ReadonlyArray<MediaDeviceInfo>> {
        return this.query(this.#queryEnumerateDevices("audioinput"))
    }

    static async queryListOutputDevices(): Promise<ReadonlyArray<MediaDeviceInfo>> {
        return this.query(this.#queryEnumerateDevices("audiooutput"))
    }

    static async queryAudioInputDeviceStream(sampleRate: number, deviceId?: string, channelCount: int = 2): Promise<MediaStream> {
        console.debug(`requestAudioInputDevice deviceId: ${deviceId ?? "default"}, channelCount: ${channelCount}`)
        return this.query(mediaDevices => mediaDevices.getUserMedia({
            audio: {
                ...AudioDevices.#DefaultMediaTrackConstraints(sampleRate),
                channelCount,
                deviceId
            } satisfies MediaTrackConstraints
        }))
    }

    static async #request(): Promise<void> {
        console.debug("Requesting permission to use microphone / audio devices...")
        if (!await this.#queryPermissions()) {return Promise.reject("Permission denied")}
        if (!await this.#getUserMedia()) {return Promise.reject("Permission to getUserMedia denied")}
        console.debug("Granted permission to use microphone / audio devices.")
    }

    static #DefaultMediaTrackConstraints(sampleRate: number = 48_000): MediaTrackConstraints {
        return Object.freeze({
            sampleRate,
            sampleSize: 32,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        })
    }

    static async #queryPermissions(): Promise<boolean> {
        const headline = "Permission Api"
        const {status, value: permissionState, error} =
            await Promises.tryCatch(navigator.permissions.query({name: "microphone"}))
        if (status === "rejected") {return await Dialogs.info({headline, message: String(error)}) ?? false}
        console.debug(`Permission state(${permissionState.name}): ${permissionState.state}`)
        if (permissionState.state === "granted") {return true}
        const buttons: ReadonlyArray<Button> = [{
            text: "Help",
            primary: false,
            onClick: () => window.open("/manuals/permissions", "_blank")
        }, {
            text: "Cancel",
            primary: false,
            onClick: (handler) => handler.close()
        }]
        if (permissionState.state === "denied") {
            return await Dialogs.info({
                headline, message: "Permissions to accept 'microphone / audio devices' has been denied.", buttons
            }) ?? false
        }
        if (permissionState.state === "prompt") {
            return await Dialogs.info({
                headline,
                message: "Your browser will now ask to request access to use your 'microphone / audio devices'.",
                buttons,
                okText: "Request"
            }) ?? true
        }
        return true
    }

    static async #getUserMedia(): Promise<boolean> {
        // This will trigger a prompt if needed and fail when denied
        console.debug("enter getUserMedia")
        const {status} = await Promises.tryCatch(navigator.mediaDevices
            .getUserMedia({audio: this.#DefaultMediaTrackConstraints()})
            .then(stream => stream.getTracks().forEach(track => track.stop())))
        console.debug("exit getUserMedia", status)
        return status === "resolved"
    }

    static #queryEnumerateDevices = (kind: MediaDeviceKind): Func<MediaDevices, Promise<ReadonlyArray<MediaDeviceInfo>>> =>
        mediaDevices => mediaDevices.enumerateDevices()
            .then(devices => devices.filter(device => device.kind === kind && device.deviceId !== ""))
            .then(devices => devices.length > 0 ? devices : panic("Could not list devices"))
}