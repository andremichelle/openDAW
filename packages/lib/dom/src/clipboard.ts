import {RuntimeNotifier} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"

export namespace Clipboard {
    export const writeText = async (text: string): Promise<void> => {
        const result = await Promises.tryCatch(navigator.clipboard.writeText(text))
        if (result.status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Clipboard Error",
                message: "Could not write to clipboard. Please check your browser permissions."
            })
        }
    }
    export const readText = async (): Promise<string> => {
        const result = await Promises.tryCatch(navigator.clipboard.readText())
        if (result.status === "resolved") {return result.value}
        await RuntimeNotifier.info({
            headline: "Clipboard Error",
            message: "Could not read from clipboard. Please check your browser permissions."
        })
        return ""
    }
}
