import {Provider, RuntimeNotifier} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Shell} from "@/platform/desktop/Shell"

export namespace DesktopLifecycle {
    const state = {closing: false}

    const guardClose = (hasUnsavedWork: Provider<boolean>): void => {
        Shell.info().close = async () => {
            if (state.closing) {return}
            state.closing = true
            const quit = !hasUnsavedWork() || await RuntimeNotifier.approve({
                headline: "Quit openDAW",
                message: "The project has unsaved changes. Quit anyway?",
                approveText: "Quit"
            })
            state.closing = false
            if (quit) {await Shell.request("quit", {})}
        }
        Shell.request("guard", {}).catch(error => console.warn("[DesktopLifecycle]", error))
    }

    // WKWebView shows no window.alert, the shell opens a native message dialog
    const alert = (message: string): void => {
        Shell.request("alert", {}, message).catch(error => console.warn("[DesktopLifecycle]", error, message))
    }

    export const install = (): void => Platform.install({guardClose, alert})
}
