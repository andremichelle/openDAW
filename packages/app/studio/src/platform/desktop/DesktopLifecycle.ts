import {Provider} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Shell} from "@/platform/desktop/Shell"

export namespace DesktopLifecycle {
    const state = {closing: false}

    const guardClose = (hasUnsavedWork: Provider<boolean>): void => {
        Shell.info().close = async () => {
            if (state.closing) {return}
            state.closing = true
            const quit = !hasUnsavedWork() || await confirm("Quit openDAW", "The project has unsaved changes. Quit anyway?", "Quit")
                .catch(error => {
                    console.warn("[DesktopLifecycle]", error)
                    return false
                })
            state.closing = false
            // a logout or restart macOS asked for waits for this answer
            await Shell.request(quit ? "quit" : "quit-cancel", {})
        }
        Shell.request("guard", {}).catch(error => console.warn("[DesktopLifecycle]", error))
    }

    // a native dialog stays above the floating plugin windows, an in-page dialog would be covered
    const confirm = async (title: string, message: string, ok: string): Promise<boolean> =>
        await (await Shell.request("confirm", {title, ok}, message)).text() === "true"

    // WKWebView shows no window.alert, the shell opens a native message dialog
    const alert = (message: string): void => {
        Shell.request("alert", {}, message).catch(error => console.warn("[DesktopLifecycle]", error, message))
    }

    // WebKit goes back in history on Backspace (the Mac Delete key), which would leave the project
    const blockBackNavigation = (): void => window.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Backspace") {return}
        const target = event.target
        const editable = target instanceof HTMLElement && (target.isContentEditable
            || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
        if (!editable) {event.preventDefault()}
    }, {capture: true})

    export const install = (): void => {
        Platform.install({guardClose, alert})
        blockBackNavigation()
    }
}
