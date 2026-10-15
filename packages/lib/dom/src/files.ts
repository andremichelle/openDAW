import {Errors, MutableObservableOption, Option, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Platform} from "./platform"

export namespace Files {
    export const save = (arrayBuffer: ArrayBuffer, options?: SaveFilePickerOptions): Promise<string> =>
        Platform.saveFile(arrayBuffer, options)

    // browsers need a user-input to allow download
    export const saveWithApproval = async ({buffer, headline, message, suggestedName, types}: {
        buffer: ArrayBuffer,
        headline: string,
        message?: string,
        suggestedName: string,
        types?: ReadonlyArray<FilePickerAcceptType>
    }): Promise<void> => {
        const approved = await RuntimeNotifier.approve({headline, message: message ?? "", approveText: "Save"})
        if (!approved) {return}
        const {status, error} = await Promises.tryCatch(save(buffer, {suggestedName, types: types?.slice()}))
        if (status === "rejected" && !Errors.isAbort(error)) {
            panic(String(error))
        }
    }

    const pendingOpen = new MutableObservableOption<Promise<ReadonlyArray<File>>>()

    // browsers allow one native picker at a time; a re-entrant call is an abort, not an error
    export const open = (options?: OpenFilePickerOptions): Promise<ReadonlyArray<File>> => {
        if (pendingOpen.nonEmpty()) {return Promise.reject(Errors.AbortError)}
        const promise = Platform.openFiles(options).finally(() => pendingOpen.clear())
        pendingOpen.wrap(promise)
        return promise
    }

    export const canSaveStream = (): boolean => Platform.canSaveStream()

    export const saveStream = (options: SaveFilePickerOptions): Promise<Option<WritableStream>> =>
        Platform.saveStream(options)
}
