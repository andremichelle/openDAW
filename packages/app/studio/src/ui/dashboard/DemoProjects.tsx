import css from "./DemoProjects.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, Option, RuntimeNotifier} from "@opendaw/lib-std"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {DemoProjectJson} from "@/ui/dashboard/DemoProjectJson"
import {DemoProject} from "@/ui/dashboard/DemoProject"
import {network, Promises} from "@opendaw/lib-runtime"
import {ProjectBundle} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "DemoProjects")

type TracksList = { tracks: Array<DemoProjectJson> }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const listUrl = "https://api.opendaw.studio/music/list.php"

const NewProjectJson: DemoProjectJson = {
    id: "",
    hasCover: false,
    metadata: {
        name: "Empty",
        artist: "openDAW",
        description: "",
        tags: ["clean slate"],
        created: "",
        modified: "",
        coverMimeType: ""
    }
}

const loadDemoProject = async (service: StudioService, json: DemoProjectJson) => {
    const dialog = RuntimeNotifier.progress({headline: "Loading Demo Project"})
    const folder = json.id
    const {status, value: arrayBuffer, error} = await Promises.tryCatch(
        fetch(`https://api.opendaw.studio/music/uploads/${folder}/project.odb`)
            .then(network.progress(progress => dialog.message = `Downloading bundle file... (${(progress * 100).toFixed(1)}%)`))
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
}

export const DemoProjects = ({service}: Construct) => (
    <div className={className}>
        <h3 style={{color: Colors.orange.toString()}}>Start</h3>
        <div className="projects">
            <DemoProject json={NewProjectJson} load={() => service.newProject()}/>
            <hr/>
            <Await
                factory={() => fetch(listUrl)
                    .then(res => res.json())
                    .then(res => res as TracksList)
                    .then(list => list.tracks
                        .sort(({metadata: {modified: a}}, {metadata: {modified: b}}) => b.localeCompare(a)))}
                loading={() => <div>{ThreeDots()}</div>}
                failure={({retry, reason}) => (
                    <div style={{margin: "8px 0 0 4px", justifySelf: "center"}}>
                        <span>{reason}</span> <span onclick={retry}
                                                    style={{
                                                        color: Colors.orange.toString(),
                                                        cursor: "pointer"
                                                    }}>Click to retry.</span>
                    </div>
                )}
                success={(tracks) => tracks.map(json => (
                    <DemoProject json={json} load={() => loadDemoProject(service, json)}/>
                ))}/>
        </div>
    </div>
)