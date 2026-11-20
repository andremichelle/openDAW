import css from "./CompositeCellControls.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioEffectCompositeBoxAdapter, AudioEffectCompositeCellBoxAdapter, CompositeCell} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {CompositeCellStrip} from "@/ui/devices/CompositeCellStrip"

const className = Html.adoptStyleSheet(css, "CompositeCellControls")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    cell: CompositeCell
    className?: string
}

export const CompositeCellControls = ({lifecycle, project, cell, className: extraClass}: Construct) => (
    <div className={Html.buildClassList(className, extraClass)}>
        <CompositeCellStrip lifecycle={lifecycle} project={project} cell={cell}
                            noun="layer"
                            send={cell instanceof AudioEffectCompositeCellBoxAdapter
                            && cell.compositeDevice() instanceof AudioEffectCompositeBoxAdapter
                                ? cell.namedParameter.send : undefined}/>
    </div>
)
