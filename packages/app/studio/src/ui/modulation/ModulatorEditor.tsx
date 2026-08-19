import css from "./ModulatorEditor.sass?inline"
import {Errors, Lifecycle, ObservableValue, panic} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {ModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem} from "@opendaw/studio-core"
import {ModulatorReveal} from "@/ui/modulation/ModulatorReveal.ts"
import {TargetList} from "@/ui/modulation/TargetList.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"

const className = Html.adoptStyleSheet(css, "ModulatorEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: ModulatorBoxAdapter
}

export const ModulatorEditor = ({lifecycle, service, modulator}: Construct, controls: JsxValue) => {
    const {project} = service
    const {editing} = project
    const labelField = modulator.box.label
    const title: HTMLElement = (
        <h1 onInit={element => lifecycle.ownAll(
            labelField.catchupAndSubscribe(owner => element.textContent = owner.getValue()),
            Events.subscribeDblDwn(element, async event => {
                const {status, error, value} = await Promises.tryCatch(
                    Surface.get(element).requestFloatingTextInput(event, labelField.getValue()))
                if (status === "rejected") {
                    if (!Errors.isAbort(error)) {return panic(error)}
                } else {
                    editing.modify(() => labelField.setValue(value))
                }
            })
        )}/>
    )
    return (
        <div className={className}
             onInit={element => lifecycle.own(modulator.box.enabled
                 .catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                     element.classList.toggle("disabled", !owner.getValue())))}>
            <div className="modulator">
                <header>
                    {title}
                    <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        MenuItem.default({label: "Replace with"}).setRuntimeChildrenProcedure(sub =>
                            sub.addMenuItem(...Modulators.Kinds.map(kind => MenuItem.default({
                                label: kind.label,
                                checked: kind.boxName === modulator.box.name,
                                selectable: kind.boxName !== modulator.box.name
                            }).setTriggerProcedure(() => editing.modify(() =>
                                Modulators.replace(project, modulator.box, kind)))))),
                        MenuItem.default({label: "Duplicate"}).setTriggerProcedure(() =>
                            editing.modify(() => Modulators.duplicate(project, modulator.box))
                                .ifSome(box => ModulatorReveal.request(box.address.uuid)))))}
                                appearance={{}}>
                        <Icon symbol={IconSymbol.Menu}/>
                    </MenuButton>
                    <Icon symbol={IconSymbol.Shutdown} className="toggle" onInit={element =>
                        lifecycle.own(Events.subscribe(element, "click", () =>
                            editing.modify(() => modulator.box.enabled.toggle())))}/>
                    <Button lifecycle={lifecycle} onClick={() => editing.modify(() => modulator.box.delete())}>
                        <Icon symbol={IconSymbol.Delete}/>
                    </Button>
                </header>
                <div className="body">{controls}</div>
            </div>
            <TargetList lifecycle={lifecycle} service={service} modulator={modulator}/>
        </div>
    )
}