import css from "./ModulationPanel.sass?inline"
import {isInstanceOf, Lifecycle, Terminator, UUID} from "@opendaw/lib-std"
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
import {ModulatorReveal} from "@/ui/modulation/ModulatorReveal.ts"

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
        <div className="scroller" onConnect={host => {
            revealRequested()
            return lifecycle.own(installScrollbars(host))
        }}>
            <h5 className="head modulators">
                <span>Modulators</span>
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                    parent.addMenuItem(...Modulators.Kinds.map(kind => MenuItem.default({label: kind.label})
                        .setTriggerProcedure(() => editing.modify(() => kind.create(project))))))}
                            appearance={{}}>
                    <Icon symbol={IconSymbol.Add}/>
                </MenuButton>
            </h5>
            <h5 className="head targets"><span>Targets</span></h5>
        </div>
    )
    const element: HTMLElement = <div className={className}>{scroller}</div>
    const editors = UUID.newSet<{uuid: UUID.Bytes, element: HTMLElement}>(entry => entry.uuid)
    /// The editor's own element is `display: contents`, so the scroll must target the row that has a box.
    const revealRequested = () => ModulatorReveal.requested.ifSome(uuid => editors.opt(uuid)
        .ifSome(({element}) => {
            const row = element.firstElementChild
            if (!isInstanceOf(row, HTMLElement) || !row.isConnected) {return}
            row.scrollIntoView({block: "nearest"})
            ModulatorReveal.requested.clear()
        }))
    const render = () => {
        contents.terminate()
        editors.clear()
        while (scroller.childElementCount > 2) {scroller.lastElementChild?.remove()}
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            scroller.append(<div className="placeholder">
                Add a modulator, or right-click any device control and choose Modulate
            </div>)
            return
        }
        adapters.forEach((adapter: ModulatorBoxAdapter) => {
            const element = createModulatorEditor(contents, service, adapter) as HTMLElement
            editors.add({uuid: adapter.uuid, element})
            scroller.append(element)
        })
        revealRequested()
    }
    lifecycle.ownAll(
        rootBoxAdapter.modulators.catchupAndSubscribe({
            onAdd: () => render(),
            onRemove: () => render(),
            onReorder: () => render()
        }),
        ModulatorReveal.requested.subscribe(() => revealRequested()))
    render()
    return element
}
