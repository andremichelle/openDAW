import css from "./DemoProject.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {DemoProjectJson} from "@/ui/dashboard/DemoProjectJson"
import {Exec} from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "DemoProject")

type Construct = {
    json: DemoProjectJson
    load: Exec
}

export const DemoProject = ({json, load}: Construct) => {
    const coverUrl = json.hasCover
        ? `https://api.opendaw.studio/music/cover.php?id=${json.id}&preview=true`
        : "./empty.svg"
    return (
        <div className={className} onclick={load}>
            <img src={coverUrl} alt="cover" crossOrigin="anonymous"/>
            <div className="meta">
                <div className="title">
                    <span className="name">{json.metadata.name}</span>
                    <span> by </span>
                    <span className="artist">{json.metadata.artist}</span>
                </div>
                <div className="tags">{json.metadata.tags.slice(0, 4).map(tag => <div>{tag}</div>)}</div>
            </div>
        </div>
    )
}