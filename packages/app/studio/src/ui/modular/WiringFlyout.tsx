import css from "./WiringFlyout.sass?inline"
import {Point, Terminator} from "@moises-ai/lib-std"
import {Icon} from "@/ui/components/Icon.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {ModuleConnectionAdapter, ModuleConnectorAdapter} from "@moises-ai/studio-adapters"
import {IconSymbol} from "@moises-ai/studio-enums"
import {ModularEnvironment} from "@/ui/modular/ModularEnvironment.ts"
import {Events, Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "WiringFlyout")

const ConnectionIndicator = ({}: { connection: ModuleConnectionAdapter }) => (
    <svg classList="connection" viewBox="0 0 32 16" width={28} height={14}>
        <circle cx="7" cy="8" r="4" fill="currentColor"/>
        <circle cx="25" cy="8" r="4" fill="currentColor"/>
        <line x1="11" y1="8" x2="21" y2="8"/>
    </svg>
)

type Construct = {
    autoTerminator: Terminator
    environment: ModularEnvironment
    connectorAdapter: ModuleConnectorAdapter<any, any>
    position: Point
}

export const WiringFlyout = ({autoTerminator, environment, connectorAdapter, position}: Construct) => {
    const connections = connectorAdapter.connections
    const catchAll: Element = <Icon symbol={IconSymbol.DragConnections} style={{pointerEvents: "all"}}/>
    catchAll.classList.toggle("hidden", connections.length < 2 || true) // TODO Drag multiple connections
    const connectionCatcher: Element = (
        <div className="connections">
            {connections.toSorted((a: ModuleConnectionAdapter, b: ModuleConnectionAdapter) => {
                const counterpartA = a.target === connectorAdapter.field ? a.source : a.target
                const counterpartB = b.source === connectorAdapter.field ? b.target : b.source
                const ya = environment.findConnectorByViewAddress(counterpartA.address).pinPoint.y
                const yb = environment.findConnectorByViewAddress(counterpartB.address).pinPoint.y
                return ya - yb
            }).map(connection => {
                const button: Element = <ConnectionIndicator connection={connection}/>
                autoTerminator.own(Events.subscribe(button, "pointerover", () => {
                    const terminable = environment.highlightWire(connection)
                    Events.subscribe(button, "pointerout", () => {terminable.terminate()}, {once: true})
                }))
                autoTerminator.own(Events.subscribe(button, "pointerdown", (event: PointerEvent) => {
                    environment.beginRewiring(connection, connectorAdapter, Point.fromClient(event))
                    autoTerminator.terminate()
                }))
                return button
            })}
        </div>
    )
    connectionCatcher.classList.toggle("hidden", connections.length === 0)
    const newConnection: Element = (
        <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em">
            <circle cx={12} cy={12} r={10} fill="black"/>
            <path
                d="M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM11 11H7V13H11V17H13V13H17V11H13V7H11V11Z"></path>
        </svg>
    )
    autoTerminator.own(Events.subscribe(newConnection, "pointerdown", (event: PointerEvent) => {
        environment.beginWiring(connectorAdapter, Point.fromClient(event))
        autoTerminator.terminate()
    }))
    const element: HTMLElement = (
        <div className={className} style={{top: `${position.y}px`, left: `${position.x}px`}} tabIndex={-1}>
            {catchAll}
            {connectionCatcher}
            {newConnection}
        </div>
    )
    element.onblur = () => autoTerminator.terminate()
    autoTerminator.own(Html.watchResize(element, () => element.focus()))
    autoTerminator.own({terminate: () => element.remove()})
    return element
}