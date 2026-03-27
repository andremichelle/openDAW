import {tryCatch} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace Clipboard {
    export const writeText = async (text: string): Promise<void> => {
        const result = await Promises.tryCatch(navigator.clipboard.writeText(text))
        if (result.status === "resolved") {return}
        const textarea = document.createElement("textarea")
        textarea.value = text
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        document.body.appendChild(textarea)
        textarea.select()
        tryCatch(() => document.execCommand("copy"))
        document.body.removeChild(textarea)
    }
    export const readText = async (): Promise<string> => {
        const result = await Promises.tryCatch(navigator.clipboard.readText())
        if (result.status === "resolved") {return result.value}
        return ""
    }
}
