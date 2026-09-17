import css from "./OpenBundlePage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Project, ProjectMeta, ProjectProfile} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "OpenProjectPage")

const inflate = async (base64url: string): Promise<ArrayBuffer> => {
    const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/")
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    return new Response(stream).arrayBuffer()
}

export const OpenProjectPage: PageFactory<StudioService> = ({service}: PageContext<StudioService>) => {
    return (
        <div className={className} onInit={async (_element) => {
            const payload = location.hash.substring(1)
            const name = new URLSearchParams(location.search).get("name") ?? "Untitled"
            history.replaceState(null, "", "/") // keeps the payload out of the address bar, a reload must not reopen it
            const dialog = RuntimeNotifier.progress({headline: "Opening project..."})
            const {status, value: profile, error} = await Promises.tryCatch(inflate(payload)
                .then(buffer => Project.loadAnyVersion(service, buffer))
                .then(project => new ProjectProfile(UUID.generate(), project, ProjectMeta.init(name), Option.None)))
            dialog.terminate()
            if (status === "rejected") {
                return RuntimeNotifier.info({headline: "Could not open project", message: String(error)})
            }
            service.projectProfileService.setValue(Option.wrap(profile))
        }}/>
    )
}
