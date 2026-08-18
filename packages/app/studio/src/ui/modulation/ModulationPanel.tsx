import css from "./ModulationPanel.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {ModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem} from "@opendaw/studio-core"
import {createModulatorEditor} from "@/ui/modulation/ModulatorEditorFactory.tsx"
import {installScrollbars} from "@/ui/components/Scrollbars.tsx"

const className = Html.adoptStyleSheet(css, "ModulationPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ModulationPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const contents = lifecycle.own(new Terminator())
    const scroller: HTMLElement = (
        <div className="scroller" onConnect={host => lifecycle.own(installScrollbars(host))}>
            <h5 className="head modulators">
                <span>Modulators</span>
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({label: "LFO"})
                        .setTriggerProcedure(() => editing.modify(() => Modulators.createLfo(project))),
                    MenuItem.default({label: "Steps"})
                        .setTriggerProcedure(() => editing.modify(() => Modulators.createSteps(project))),
                    MenuItem.default({label: "Macro"})
                        .setTriggerProcedure(() => editing.modify(() => Modulators.createMacro(project)))))}
                            appearance={{}}>
                    <Icon symbol={IconSymbol.Add}/>
                </MenuButton>
            </h5>
            <h5 className="head targets"><span>Targets</span></h5>
        </div>
    )
    const element: HTMLElement = <div className={className}>{scroller}</div>
    const render = () => {
        contents.terminate()
        while (scroller.childElementCount > 2) {scroller.lastElementChild?.remove()}
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            scroller.append(<div className="placeholder">
                Add a modulator, or right-click any device control and choose Modulate
            </div>)
            return
        }
        adapters.forEach((adapter: ModulatorBoxAdapter) =>
            scroller.append(createModulatorEditor(contents, service, adapter) as HTMLElement))
    }
    lifecycle.own(rootBoxAdapter.modulators.catchupAndSubscribe({
        onAdd: () => render(),
        onRemove: () => render(),
        onReorder: () => render()
    }))
    render()
    return element
}
