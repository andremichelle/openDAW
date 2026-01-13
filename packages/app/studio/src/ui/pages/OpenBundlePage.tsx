import css from "./OpenBundlePage.sass?inline"
import {createElement, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@moises-ai/lib-dom"
import {network, Promises} from "@moises-ai/lib-runtime"
import {Option, RuntimeNotifier} from "@moises-ai/lib-std"
import {ProjectBundle} from "@moises-ai/studio-core"

const className = Html.adoptStyleSheet(css, "OpenBundlePage")

export const OpenBundlePage: PageFactory<StudioService> = ({service, path}: PageContext<StudioService>) => {
    const message: HTMLElement = <h5/>
    return (
        <div className={className} onInit={async (_element) => {
            const dialog = RuntimeNotifier.progress({headline: "Loading bundle file..."})
            const folder = path.substring(path.lastIndexOf("/") + 1)
            const {status, value: arrayBuffer, error} = await Promises.tryCatch(
                fetch(`https://api.opendaw.studio/music/uploads/${folder}/project.odb`)
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
                service.switchScreen("default")
            }
        }}>{message}</div>
    )
}