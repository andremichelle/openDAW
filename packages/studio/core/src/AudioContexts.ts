import {Promises} from "@opendaw/lib-runtime"
import {RuntimeNotifier} from "@opendaw/lib-std"

export class AudioContexts {
    static #failureNotified: boolean = false

    static async resume(context: AudioContext): Promise<boolean> {
        if (context.state !== "suspended") {return context.state === "running"}
        const {status, error} = await Promises.tryCatch(context.resume())
        if (status === "resolved") {return true}
        console.warn("AudioContext.resume rejected", error, {
            state: context.state,
            sampleRate: context.sampleRate,
            hardwareSampleRate: await this.#probeHardwareSampleRate()
        })
        if (!this.#failureNotified) {
            this.#failureNotified = true
            RuntimeNotifier.info({
                headline: "Audio Device Unavailable",
                message: "Your browser could not start the audio device. Check your audio output settings and try again."
            }).then(() => {this.#failureNotified = false})
        }
        return false
    }

    // The rate the browser would pick on its own, to tell a device failure from our 48kHz request being refused.
    static async #probeHardwareSampleRate(): Promise<number> {
        const {status, value: context} = await Promises.tryCatch(Promise.resolve(new AudioContext()))
        if (status === "rejected") {return NaN}
        const {sampleRate} = context
        await Promises.tryCatch(context.close())
        return sampleRate
    }
}
