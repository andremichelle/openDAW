import css from "./ModulationPanel.sass?inline"
import {Errors, Lifecycle, panic, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {createModulatorEditor} from "@/ui/modulation/ModulatorEditorFactory.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"

const className = Html.adoptStyleSheet(css, "ModulationPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ModulationPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const navigation: HTMLElement = <div className="list"/>
    const editors: HTMLElement = <div className="editors"/>
    const elements = new Map<string, HTMLElement>()
    const contents = lifecycle.own(new Terminator())
    const render = () => {
        contents.terminate()
        elements.clear()
        Html.empty(navigation)
        Html.empty(editors)
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            navigation.append(<div className="empty">No modulators yet</div>)
            editors.append(<div className="placeholder">
                Add a modulator, or right-click any control and choose Modulate
            </div>)
            return
        }
        adapters.forEach((adapter: LfoModulatorBoxAdapter) => {
            const key = UUID.toString(adapter.uuid)
            const name: HTMLElement = <span className="name"/>
            const editor = createModulatorEditor(contents, service, adapter) as HTMLElement
            elements.set(key, editor)
            contents.ownAll(
                adapter.box.label.catchupAndSubscribe(owner => name.textContent = owner.getValue()),
                Events.subscribeDblDwn(name, async event => {
                    const {status, error, value} = await Promises.tryCatch(
                        Surface.get(name).requestFloatingTextInput(event, adapter.box.label.getValue()))
                    if (status === "rejected") {
                        if (!Errors.isAbort(error)) {return panic(error)}
                    } else {
                        editing.modify(() => adapter.box.label.setValue(value))
                    }
                })
            )
            navigation.append(
                <div className="entry"
                     onclick={() => elements.get(key)?.scrollIntoView({behavior: "smooth", block: "start"})}>
                    <Icon symbol={IconSymbol.Waveform}/>
                    {name}
                </div>
            )
            editors.append(editor)
        })
    }
    lifecycle.own(rootBoxAdapter.modulators.catchupAndSubscribe({
        onAdd: () => render(),
        onRemove: () => render(),
        onReorder: () => render()
    }))
    render()
    return (
        <div className={className}>
            <div className="column modulators">
                <h5>
                    <span>Modulators</span>
                    <span className="spacer"/>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => Modulators.createLfo(project))}>
                        <Icon symbol={IconSymbol.Add}/>
                    </Button>
                </h5>
                {navigation}
            </div>
            {editors}
        </div>
    )
}
