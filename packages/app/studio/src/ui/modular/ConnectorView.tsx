import css from "./ConnectorView.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {ModuleAdapter, ModuleConnectorAdapter} from "@opendaw/studio-adapters"
import {Lifecycle, Point, Rect, Terminator} from "@opendaw/lib-std"
import {ConnectorViewAdapter, ModularEnvironment} from "@/ui/modular/ModularEnvironment.ts"
import {WiringFlyout} from "@/ui/modular/WiringFlyout.tsx"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {Surface} from "../surface/Surface.tsx"
import {Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Connector")

type Construct = {
    lifecycle: Lifecycle
    environment: ModularEnvironment
    moduleAdapter: ModuleAdapter
    connectorAdapter: ModuleConnectorAdapter<any, any>
    parent: Element
    headerPin: Element
}

export const ConnectorView =
    ({lifecycle, environment, moduleAdapter, connectorAdapter, parent, headerPin}: Construct) => {
        const {attributes: {x: moduleX, y: moduleY}} = moduleAdapter
        const pin: Element = <div className="pin"/>
        const pinLocator = (): Point => {
            const moduleRect = parent.getBoundingClientRect()
            const reference = pin.checkVisibility() ? pin : headerPin
            const pinCenter = Rect.center(reference.getBoundingClientRect())
            return {
                x: (pinCenter.x - moduleRect.x) + moduleX.getValue() + 0.5,
                y: (pinCenter.y - moduleRect.y) + moduleY.getValue() + 0.5
            }
        }
        const element: HTMLElement = (
            <div className={Html.buildClassList(className, connectorAdapter.direction)}>
                <label>{connectorAdapter.name}</label>
                {pin}
            </div>
        )
        lifecycle.own(ContextMenu.subscribe(element, collector => {
            collector.addItems(MenuItem.default({
                label: "Connect... (todo)",
                selectable: false
            }))
        }))
        lifecycle.own(environment.registerConnectorView(new ConnectorViewAdapter(connectorAdapter, pin, pinLocator)))

        const showWiringWidget = () => {
            const pinCenter = Rect.center(pin.getBoundingClientRect())
            const terminator = lifecycle.own(new Terminator())
            Surface.get(element).flyout.appendChild(
                <WiringFlyout autoTerminator={terminator}
                              environment={environment}
                              connectorAdapter={connectorAdapter}
                              position={pinCenter}/>
            )
        }

        let preventClick: boolean = false
        lifecycle.own(Events.subscribe(pin, "pointerdown", (event) => {
            event.stopPropagation()
            if (event.shiftKey) {
                preventClick = true
                environment.beginWiring(connectorAdapter, Point.fromClient(event))
            } else {
                preventClick = false
            }
        }))
        lifecycle.own(Events.subscribe(pin, "click", (event) => {
            if (preventClick || event.ctrlKey) {return}
            event.stopPropagation()
            showWiringWidget()
        }))
        lifecycle.own(Events.subscribe(pin, "pointerleave", (event: PointerEvent) => {
            if (event.buttons === 1 && !environment.isWiring) {
                const connections = connectorAdapter.connections
                if (connections.length === 0) {
                    environment.beginWiring(connectorAdapter, Point.fromClient(event))
                    preventClick = true
                } else if (connections.length === 1) {
                    environment.beginRewiring(connections[0], connectorAdapter, Point.fromClient(event))
                    preventClick = true
                } else {
                    showWiringWidget()
                }
            }
        }))
        return element
    }