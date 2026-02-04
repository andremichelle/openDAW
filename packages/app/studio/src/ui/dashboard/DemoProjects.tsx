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

const ids = [
    "8dd3364e113", // The Rocinante Experience
    "84f9c4fbb76", // Ambition
    "3a96772867c", // Fleur de Soul
    "97b0564366f", // Centauri
    "f9e029edeb0", // OpenDub Experience
    "0d8b487992b", // Chaotic
    "3038c24e87e", // Bury Me by Skyence Remix
    "468309b2035", // Sturm Chaser
    "932e7c1d1f1", // Liquid
    "7a5be6e2478", // Ben
    "16982e85776", // Fatso
    "1cc67c64dde", // Seek Deeper
    "65efa1e1f7f", // Shafted
    "b41528b9c53", // Dub Speak
    "b43d04558ec", // Sunset
    "cab976763f0" // Vapor Run
]

const listUrl = `https://api.opendaw.studio/music/list-by-ids.php?ids=${ids.join(",")}`

const NewProjectJson: DemoProjectJson = {
    id: "",
    hasCover: false,
    bundleSize: 0,
    metadata: {
        name: "New Project",
        artist: "openDAW",
        description: "",
        tags: ["clean slate"],
        created: "",
        modified: "",
        coverMimeType: ""
    }
}

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {return `${bytes} B`}
    if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`}
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const loadDemoProject = async (service: StudioService, json: DemoProjectJson) => {
    const sizeInfo = `(${formatBytes(json.bundleSize)})`
    const approved = await RuntimeNotifier.approve({
        headline: "Install Demo Project",
        message: `Do you want to download the project bundle file ${sizeInfo}?`
    })
    if (!approved) {return}
    const dialog = RuntimeNotifier.progress({headline: "Loading Demo Project"})
    const folder = json.id
    const {status, value: arrayBuffer, error} = await Promises.tryCatch(
        fetch(`https://api.opendaw.studio/music/uploads/${folder}/project.odb`)
            .then(network.progress(progress => dialog.message = `Downloading bundle file... (${(progress * 100).toFixed(1)}%)`))
            .then(x => x.arrayBuffer()))
    dialog.terminate()
    if (status === "rejected") {
        return RuntimeNotifier.info({headline: "Could not load bundle file", message: String(error)})
    }
    const {status: decodeStatus, value: profile, error: decodeError} =
        await Promises.tryCatch(ProjectBundle.decode(service, arrayBuffer))
    if (decodeStatus === "rejected") {
        return RuntimeNotifier.info({headline: "Could not decode bundle file", message: String(decodeError)})
    }
    await profile.saveAs(profile.meta)
    service.projectProfileService.setValue(Option.wrap(profile))
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
                    .then(list => list.tracks)}
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