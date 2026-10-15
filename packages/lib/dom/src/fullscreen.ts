import {isDefined, RuntimeNotifier, tryCatch} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Platform} from "./platform"

export namespace Fullscreen {
    export const isAvailable = (element: Element): boolean => Platform.isFullscreenAvailable(element)
    export const request = async (element: Element): Promise<boolean> => {
        if (!isAvailable(element)) {
            await RuntimeNotifier.info({
                headline: "Fullscreen Unavailable",
                message: "Fullscreen is disabled or not supported in this browser.",
                origin: element
            })
            return false
        }
        // extensions may replace requestFullscreen with a wrapper that throws instead of rejecting
        const call = tryCatch(() => Platform.requestFullscreen(element))
        const result = call.status === "success" ? await Promises.tryCatch(call.value) : call
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
        if (isDefined(Platform.fullscreenElement(document))) {
            await Promises.tryCatch(Platform.exitFullscreen(document))
            return false
        }
        return request(element)
    }
}