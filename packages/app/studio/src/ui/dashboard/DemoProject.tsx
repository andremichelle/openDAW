import css from "./DemoProject.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {DemoProjectJson} from "@/ui/dashboard/DemoProjectJson"
import {Bytes, Exec, Strings} from "@moises-ai/lib-std"

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
                    {
                        json.bundleSize > 0 && (
                            <span className="size">({Bytes.toString(json.bundleSize)})</span>
                        )
                    }
                </div>
                <div className="tags">{json.metadata.tags
                    .slice(0, 4)
                    .filter(tag => Strings.nonEmpty(tag))
                    .map(tag => <div>{tag}</div>)}</div>
            </div>
        </div>
    )
}