import css from "./ModularWires.sass?inline"
import {
    assert,
    Lifecycle,
    Point,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    UUID,
    VitalSigns
} from "@moises-ai/lib-std"
import {appendChildren, createElement} from "@moises-ai/lib-jsx"
import {ConnectorViewAdapter, ModularEnvironment, WiringPreview} from "@/ui/modular/ModularEnvironment.ts"
import {ModuleAdapter, ModuleConnectionAdapter, ModuleConnectorAdapter} from "@moises-ai/studio-adapters"
import {Camera} from "@/ui/modular/Camera.ts"
import {AnimationFrame, deferNextFrame, Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "ModularWires")

type Construct = {
    lifecycle: Lifecycle
    environment: ModularEnvironment
    camera: Camera
}

type ConnectionView = {
    adapter: ModuleConnectionAdapter
    wire: SVGPathElement
}

export const ModularWires = ({lifecycle, environment, camera}: Construct) => {
    const vitalSigns = lifecycle.own(new VitalSigns())
    const wires: SVGGraphicsElement = <g classList="wires"/>
    const svg: SVGSVGElement = <svg classList={className} viewBox="0 0 1 1">{wires}</svg>
    const connections: SortedSet<UUID.Bytes, ConnectionView> = UUID.newSet(view => view.adapter.uuid)
    const updateWirePath = (path: SVGPathElement, {x: x1, y: y1}: Point, {x: x2, y: y2}: Point): void => {
        const dx = x2 - x1
        const dy = y2 - y1
        const dd = Math.sqrt(dx * dx + dy * dy)
        const minOutreach = Math.min(64, dd)
        const c1 = x1 + Math.max(minOutreach, dx * 0.5)
        const c2 = x2 - Math.max(minOutreach, dx * 0.5)
        path.setAttribute("d", `M${x1},${y1}C${c1},${y1} ${c2},${y2} ${x2},${y2}`)
    }
    const updateWriteLine = (line: SVGLineElement,
                             {x: x1, y: y1}: Point,
                             {x: x2, y: y2}: Point,
                             locked: boolean): void => {
        line.x1.baseVal.value = x1
        line.y1.baseVal.value = y1
        if (locked) {
            const dx = x2 - x1
            const dy = y2 - y1
            const dd = 1.0 / Math.sqrt(dx * dx + dy * dy) * 3 // radius of pin
            line.x2.baseVal.value = x2 - dx * dd
            line.y2.baseVal.value = y2 - dy * dd
        } else {
            line.x2.baseVal.value = x2
            line.y2.baseVal.value = y2
        }
    }
    const updateConnection = ({box: {source, target}, uuid}: ModuleConnectionAdapter): void => {
        if (vitalSigns.isTerminated) {return}
        const v1 = source.targetVertex.unwrap("No source vertex")
        const v2 = target.targetVertex.unwrap("No target vertex")
        const {pinPoint: p1}: ConnectorViewAdapter = environment.findConnectorByViewAddress(v1.address)
        const {pinPoint: p2}: ConnectorViewAdapter = environment.findConnectorByViewAddress(v2.address)
        updateWirePath(connections.get(uuid).wire, p1, p2)
    }
    const updateQueue: Set<ModuleAdapter> = new Set()
    const updateDefer = deferNextFrame(() => {
        const connections: Set<ModuleConnectionAdapter> = new Set()
        updateQueue.forEach(moduleAdapter => {
            const collector = (connector: ModuleConnectorAdapter<any, any>) =>
                connector.connections.forEach(connection => connections.add(connection))
            moduleAdapter.inputs.forEach(collector)
            moduleAdapter.outputs.forEach(collector)
        })
        updateQueue.clear()
        connections.forEach(connection => updateConnection(connection))
    })
    const modules: SortedSet<UUID.Bytes, {
        uuid: UUID.Bytes,
        subscriptions: Subscription
    }> = UUID.newSet(entry => entry.uuid)
    lifecycle.own(environment.modularAdapter.catchupAndSubscribe({
        onModuleAdded: (adapter: ModuleAdapter) => {
            const enqueue = () => {
                updateQueue.add(adapter)
                updateDefer.request()
            }
            const subscriptions: Terminator = new Terminator()
            subscriptions.own(adapter.attributes.x.subscribe(enqueue))
            subscriptions.own(adapter.attributes.y.subscribe(enqueue))
            subscriptions.own(adapter.attributes.collapsed.subscribe(enqueue))
            modules.add({uuid: adapter.uuid, subscriptions})
            enqueue()
        },
        onModuleRemoved: (adapter: ModuleAdapter) => {
            modules.removeByKey(adapter.uuid).subscriptions.terminate()
            updateQueue.delete(adapter)
        },
        onConnectionAdded: (adapter: ModuleConnectionAdapter) => {
            const wire: SVGPathElement = <path stroke={Colors.blue}/>
            wires.appendChild(wire)
            const added = connections.add({adapter, wire})
            assert(added, "Could not add connection")
            AnimationFrame.once(() => updateConnection(adapter))
        },
        onConnectionRemoved: (adapter: ModuleConnectionAdapter) =>
            connections.removeByKey(adapter.uuid).wire.remove()
    }))
    lifecycle.own(Html.watchResize(svg, ({contentRect}) =>
        svg.setAttribute("viewBox", `0 0 ${contentRect.width} ${contentRect.height}`)))

    environment.setWiringPreview({
        begin: (connector: ConnectorViewAdapter, pointer: Point) => {
            const path: SVGLineElement = <line stroke={Colors.blue}/>
            wires.appendChild(path)
            updateWriteLine(path, connector.pinPoint, camera.globalToLocal(pointer.x, pointer.y), false)
            return ({
                update: (pointer: Point, locked: boolean) =>
                    updateWriteLine(path, connector.pinPoint, camera.globalToLocal(pointer.x, pointer.y), locked),
                terminate: () => path.remove()
            })
        },
        highlight: (connection: UUID.Bytes): Terminable => {
            connections.get(connection).wire.classList.add("highlight")
            return {terminate: () => connections.get(connection).wire.classList.remove("highlight")}
        }
    } satisfies WiringPreview)
    appendChildren(wires, (
        <g stroke="rgba(255, 255, 255, 0.1)">
            <line x1={-3} x2={3} y1={0} y2={0}/>
            <line x1={0} x2={0} y1={-3} y2={3}/>
        </g>
    ))
    return svg
}