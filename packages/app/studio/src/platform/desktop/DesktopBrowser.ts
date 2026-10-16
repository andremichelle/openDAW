import {Nullable} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Shell} from "@/platform/desktop/Shell"

export namespace DesktopBrowser {
    // providers refuse logins inside a webview, the callback page hands the result back through the shell
    const openAuthWindow = (url: string, _target: string): Nullable<Pick<Window, "close">> => {
        Shell.request("browse", {url}).catch(error => console.warn("[DesktopBrowser]", error))
        return {close: () => {}}
    }

    export const install = (): void => Platform.install({openAuthWindow})
}
