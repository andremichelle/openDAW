import css from "./ModulationPanel.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {createModulatorEditor} from "@/ui/modulation/ModulatorEditorFactory.tsx"

const className = Html.adoptStyleSheet(css, "ModulationPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ModulationPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const editors: HTMLElement = <div className="editors"/>
    const contents = lifecycle.own(new Terminator())
    const render = () => {
        contents.terminate()
        Html.empty(editors)
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            editors.append(<div className="placeholder">
                Add a modulator, or right-click any control and choose Modulate
            </div>)
            return
        }
        adapters.forEach((adapter: LfoModulatorBoxAdapter) =>
            editors.append(createModulatorEditor(contents, service, adapter) as HTMLElement))
    }
    lifecycle.own(rootBoxAdapter.modulators.catchupAndSubscribe({
        onAdd: () => render(),
        onRemove: () => render(),
        onReorder: () => render()
    }))
    render()
    return (
        <div className={className}>
            <h5>
                <span>Modulators</span>
                <span className="spacer"/>
                <Button lifecycle={lifecycle}
                        onClick={() => editing.modify(() => Modulators.createLfo(project))}>
                    <Icon symbol={IconSymbol.Add}/>
                </Button>
            </h5>
            {editors}
        </div>
    )
}
