import {isDefined, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace Fullscreen {
    export const isAvailable = (element: Element): boolean =>
        element.ownerDocument.fullscreenEnabled && isDefined(element.requestFullscreen)
    export const request = async (element: Element): Promise<boolean> => {
        if (!isAvailable(element)) {
            await RuntimeNotifier.info({
                headline: "Fullscreen Unavailable",
                message: "Fullscreen is disabled or not supported in this browser.",
                origin: element
            })
            return false
        }
        const result = await Promises.tryCatch(element.requestFullscreen())
        if (result.status === "resolved") {return true}
        await RuntimeNotifier.info({
            headline: "Fullscreen Error",
            message: "The browser refused to enter fullscreen.",
            origin: element
        })
        return false
    }
    export const toggle = async (element: Element): Promise<boolean> => {
        const document = element.ownerDocument
        if (isDefined(document.fullscreenElement)) {
            await Promises.tryCatch(document.exitFullscreen())
            return false
        }
        return request(element)
    }
}