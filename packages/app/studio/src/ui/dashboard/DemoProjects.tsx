import css from "./DemoProjects.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {Await, createElement, RouteLocation} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {DemoProjectJson} from "@/ui/dashboard/DemoProjectJson"
import {DemoProject} from "@/ui/dashboard/DemoProject"

const className = Html.adoptStyleSheet(css, "DemoProjects")

type TracksList = { tracks: Array<DemoProjectJson> }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const listUrl = "https://api.opendaw.studio/music/list.php"

export const DemoProjects = ({service}: Construct) => {
    return (
        <div className={className}>
            <h3 style={{color: Colors.orange.toString()}}>Demo Projects</h3>
            <Await factory={() => fetch(listUrl)
                .then(res => res.json())
                .then(res => res as TracksList)
                .then(list => list.tracks
                    .sort(({metadata: {modified: a}}, {metadata: {modified: b}}) => b.localeCompare(a)))}
                   loading={() => ThreeDots()}
                   failure={({retry}) => <span onclick={retry}>Retry</span>}
                   success={(tracks) => (
                       <div className="projects">
                           <DemoProject json={{
                               id: "NEW",
                               hasCover: false,
                               metadata: {
                                   name: "Empty",
                                   artist: "openDAW",
                                   description: "",
                                   tags: ["clean slate"],
                                   created: "",
                                   modified: "",
                                   coverMimeType: "svg"
                               }
                           }} load={() => service.newProject()}/>
                           {tracks.map(json => (
                               <DemoProject json={json}
                                            load={() => RouteLocation.get()
                                                .navigateTo(`/open-bundle/${json.id}`)}/>
                           ))}
                       </div>
                   )}/>
        </div>
    )
}