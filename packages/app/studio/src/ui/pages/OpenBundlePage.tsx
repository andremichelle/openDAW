import css from "./OpenBundlePage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {network, Promises} from "@opendaw/lib-runtime"
import {Option, RuntimeNotifier, tryCatch} from "@opendaw/lib-std"
import {ProjectBundle} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "OpenBundlePage")

const MaxBundleBytes = 1 << 30

const stageSource = async (): Promise<Option<string>> => {
    const result = tryCatch(() => new URL(new URLSearchParams(location.search).get("url") ?? ""))
    if (result.status === "failure") {return Option.None}
    const {protocol, hostname, host} = result.value
    const local = hostname === "localhost" || hostname === "127.0.0.1"
    if (protocol !== "https:" && !(protocol === "http:" && local)) {return Option.None}
    const approved = await RuntimeNotifier.approve({
        headline: "Open Project",
        message: `This project comes from ${host}, not from openDAW. It may contain scripts that run in openDAW. Only open projects from sites you trust.`,
        approveText: "Open"
    })
    return approved ? Option.wrap(result.value.toString()) : Option.None
}

export const OpenBundlePage: PageFactory<StudioService> = ({service, path}: PageContext<StudioService>) => {
    const message: HTMLElement = <h5/>
    return (
        <div className={className} onInit={async (_element) => {
            const source = path.startsWith("/open-stage")
                ? await stageSource()
                : Option.wrap(`https://api.opendaw.studio/music/uploads/${path.substring(path.lastIndexOf("/") + 1)}/project.odb`)
            if (source.isEmpty()) {return}
            const dialog = RuntimeNotifier.progress({headline: "Loading bundle file..."})
            const {status, value: arrayBuffer, error} = await Promises.tryCatch(
                fetch(source.unwrap())
                    .then(response => Number(response.headers.get("Content-Length") ?? 0) > MaxBundleBytes
                        ? Promise.reject(new Error("The project is larger than 1 GB.")) : response)
                    .then(network.progress(progress => message.textContent = `Downloading Bundle... (${(progress * 100).toFixed(1)}%)`))
                    .then(x => x.arrayBuffer()))
            dialog.terminate()
            if (status === "rejected") {
                return RuntimeNotifier.info({headline: "Could not load bundle file", message: String(error)})
            } else {
                const {
                    status,
                    value: profile,
                    error
                } = await Promises.tryCatch(ProjectBundle.decode(service, arrayBuffer))
                if (status === "rejected") {
                    return RuntimeNotifier.info({headline: "Could not decode bundle file", message: String(error)})
                }
                service.projectProfileService.setValue(Option.wrap(profile))
            }
        }}>{message}</div>
    )
}