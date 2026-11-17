import {Promises} from "@opendaw/lib-runtime"
import {int} from "@opendaw/lib-std"
import {SoundfontBank} from "@opendaw/studio-adapters"

export namespace ExternalLib {
    const callback = (error: unknown, count: int) => {
        console.debug(`ExternalLib.importFailure count: ${count}, online: ${navigator.onLine}`, error)
        return count < 10
    }

    export const JSZip = async () => await Promises.tryCatch(Promises.guardedRetry(() =>
        import("jszip").then(({default: JSZip}) => JSZip), callback))

    export type SoundfontReader = (bytes: ArrayBuffer) => SoundfontBank.Bank

    // reads SF2, SF3 and DLS
    export const Soundfont = async () => await Promises.tryCatch(Promises.guardedRetry(() =>
        import("spessasynth_core").then(({SoundBankLoader}): SoundfontReader =>
            bytes => SoundfontBank.from(SoundBankLoader.fromArrayBuffer(bytes), bytes)), callback))
}