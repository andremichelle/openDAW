import {Nullable} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Shell} from "@/platform/desktop/Shell"

export namespace DesktopBrowser {
    // providers refuse logins inside a webview, the callback page hands the result back through the shell
    const openAuthWindow = (url: string, _target: string): Nullable<Pick<Window, "close">> => {
        Shell.request("browse", {url}).catch(error => console.warn("[DesktopBrowser]", error))
        return {close: () => {}}
    }

    // a link meant for a new tab opens in the system browser, a webview window is no browser
    const openLinksInBrowser = (event: MouseEvent): void => {
        if (event.button > 1 || !(event.target instanceof Element)) {return}
        const anchor = event.target.closest("a[target=_blank]")
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.href.startsWith("http")) {return}
        event.preventDefault()
        Shell.request("browse", {url: anchor.href}).catch(error => console.warn("[DesktopBrowser]", error))
    }

    export const install = (): void => {
        Platform.install({openAuthWindow})
        document.addEventListener("click", openLinksInBrowser, {capture: true})
        document.addEventListener("auxclick", openLinksInBrowser, {capture: true})
    }
}
