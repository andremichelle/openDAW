import css from "./GenericModuleView.sass?inline"
import {ifDefined, Lifecycle, Option, UUID} from "@moises-ai/lib-std"
import {appendChildren, createElement, Frag, Inject, JsxValue} from "@moises-ai/lib-jsx"
import {
    AutomatableParameterFieldAdapter,
    Direction,
    ModuleAdapter,
    ModuleConnectorAdapter
} from "@moises-ai/studio-adapters"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {ContextMenu, MenuItem} from "@moises-ai/studio-core"
import {ConnectorView} from "@/ui/modular/ConnectorView.tsx"
import {ModularEnvironment} from "@/ui/modular/ModularEnvironment.ts"
import {PrimitiveType} from "@moises-ai/lib-box"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {DeviceInterfaceKnobBox} from "@moises-ai/studio-boxes"
import {Events, Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"
import {IconSymbol} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "GenericModuleView")

type Construct = {
    lifecycle: Lifecycle
    environment: ModularEnvironment
    adapter: ModuleAdapter
}

export const GenericModuleView = ({lifecycle, environment, adapter}: Construct) => {
    const {selection, project} = environment
    const {editing, midiLearning} = project
    const {x, y, label, collapsed} = adapter.attributes
    const nameValue = Inject.value(label.getValue())
    lifecycle.own(label.subscribe(owner => nameValue.value = owner.getValue()))
    const headerPinInput: Element = (<div className="header-pin"/>)
    const headerPinOutput: Element = (<div className="header-pin"/>)
    const header = <header data-movable>
        {headerPinInput}
        <label>{nameValue}</label>
        <MenuButton root={MenuItem.root()
            .setRuntimeChildrenProcedure(parent => parent
                .addMenuItem(MenuItem.default({label: "Collapse", checked: collapsed.getValue()})
                    .setTriggerProcedure(() => editing.modify(() => collapsed.toggle())))
                .addMenuItem(MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => editing.modify(() => {
                        selection.selected().slice().filter(adapter => adapter.attributes.removable.getValue())
                            .forEach(adapter => adapter.box.delete())
                    })))
            )} appearance={{activeColor: Colors.dark}}>
            <Icon symbol={IconSymbol.Menu}/>
        </MenuButton>
        {headerPinOutput}
    </header>
    lifecycle.own(Events.subscribe(header, "pointerdown", (event: PointerEvent) => {
        if (!event.shiftKey && selection.count() === 1) {selection.deselectAll()}
        selection.select(adapter)
    }, {capture: true}))
    const element: HTMLDivElement = <div className={className}/>
    appendChildren(element,
        <Frag>
            {header}
            <div className="surface">
                {
                    (() => {
                        const inputs = adapter.inputs
                        const outputs = adapter.outputs
                        const elements: JsxValue = []
                        const createView = (connector: ModuleConnectorAdapter<any, any>) =>
                            elements.push(
                                <ConnectorView lifecycle={lifecycle}
                                               environment={environment}
                                               moduleAdapter={adapter}
                                               connectorAdapter={connector}
                                               parent={element}
                                               headerPin={connector.direction === Direction.Input ? headerPinInput : headerPinOutput}/>
                            )
                        const n = Math.max(inputs.length, outputs.length)
                        for (let i = 0; i < n; i++) {
                            ifDefined(inputs.at(i), createView)
                            ifDefined(outputs.at(i), createView)
                        }
                        return elements
                    })()
                }
            </div>
            <div className="surface">
                {adapter.parameters.parameters().map((parameterAdapter: AutomatableParameterFieldAdapter) => {
                    switch (parameterAdapter.type) {
                        case PrimitiveType.Int32:
                        case PrimitiveType.Float32:
                            const label: HTMLLabelElement = <label>{parameterAdapter.name}:</label>
                            lifecycle.own(ContextMenu.subscribe(label, collector => {
                                const elements = adapter.modular.device.elements()
                                const element = elements.find(element => element.parameterAdapter === parameterAdapter) ?? null
                                if (element === null) {
                                    collector.addItems(MenuItem.default({label: "Create Knob"})
                                        .setTriggerProcedure(() => {
                                            editing.modify(() =>
                                                DeviceInterfaceKnobBox.create(environment.project.boxGraph, UUID.generate(), box => {
                                                    box.index.setValue(0)
                                                    box.parameter.targetVertex = Option.wrap(parameterAdapter.field)
                                                    box.userInterface.refer(adapter.modular.device.box.userInterface.elements)
                                                }))
                                        }))
                                } else {
                                    collector.addItems(MenuItem.default({label: "Remove Knob"})
                                        .setTriggerProcedure(() => editing.modify(() => element.box.delete())))
                                }
                            }))
                            return (
                                <Frag>
                                    {label}
                                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                                               parameter={parameterAdapter}>
                                        <ParameterLabel lifecycle={lifecycle}
                                                        editing={editing}
                                                        midiLearning={midiLearning}
                                                        adapter={adapter.modular.device}
                                                        parameter={parameterAdapter}/>
                                    </RelativeUnitValueDragging>
                                </Frag>
                            )
                        case PrimitiveType.Boolean:
                            return (
                                <Checkbox lifecycle={lifecycle}
                                          model={parameterAdapter as AutomatableParameterFieldAdapter<boolean>}
                                          appearance={{activeColor: Colors.blue}}
                                          style={{fontSize: "0.75em", placeSelf: "start", marginLeft: "1px"}}>
                                    <Icon symbol={IconSymbol.Checkbox}/>
                                    <span style={{fontSize: "0.75em", marginLeft: "0.5em"}}>Enabled</span>
                                </Checkbox>
                            )
                    }
                })}
            </div>
        </Frag>
    )
    const updatePosition = () => element.style.transform =
        `translate(${x.getValue()}px, ${y.getValue()}px)`
    lifecycle.ownAll(
        x.subscribe(updatePosition),
        y.subscribe(updatePosition)
    )
    updatePosition()
    const updateCollapse = () => element.classList.toggle("collapse", collapsed.getValue())
    lifecycle.own(collapsed.subscribe(updateCollapse))
    updateCollapse()
    return element
}
