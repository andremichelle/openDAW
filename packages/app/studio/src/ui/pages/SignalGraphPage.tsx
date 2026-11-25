import css from "./SignalGraphPage.sass?inline"
import {createElement, DomElement, Frag, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {int, isDefined, Nullable, Option, UUID} from "@opendaw/lib-std"
import {Runtime} from "@opendaw/lib-runtime"
import {Colors} from "@opendaw/studio-enums"
import {
    AudioUnitBoxAdapter,
    AuxSendBoxAdapter,
    BoxAdapter,
    Devices,
    SignalGraph,
    SignalGraphEdge,
    SignalGraphNode
} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService.ts"

const className = Html.adoptStyleSheet(css, "SignalGraphPage")

const NODE_WIDTH = 164
const NODE_HEIGHT = 38
const COLUMN_GAP = 56
const ROW_GAP = 8
const LANE_PADDING = 10
const LANE_HEADER = 150
const POLL_INTERVAL_MS = 1000

type Lane = { key: string, label: string, output: boolean }
type Placed = { node: SignalGraphNode, title: string, x: number, y: number }
type LaneBand = { lane: Lane, y: number, height: number }
type Layout = { placed: Map<int, Placed>, bands: ReadonlyArray<LaneBand>, width: number, height: number }

const OTHER_LANE: Lane = {key: "other", label: "engine", output: false}

const adapterOf = (project: Project, owner: Nullable<UUID.Bytes>): Option<BoxAdapter> => isDefined(owner)
    ? project.boxGraph.findBox(owner).flatMap(box => project.boxAdapters.optAdapter(box))
    : Option.None

const laneOf = (unit: AudioUnitBoxAdapter): Lane =>
    ({key: UUID.toString(unit.uuid), label: unit.isOutput ? "Output" : unit.label, output: unit.isOutput})

const unitOf = (adapter: BoxAdapter): Option<AudioUnitBoxAdapter> => {
    if (adapter instanceof AudioUnitBoxAdapter) {return Option.wrap(adapter)}
    if (Devices.isAny(adapter)) {return Option.tryCatch(() => adapter.audioUnitBoxAdapter())}
    return Option.None
}

const titleOf = (node: SignalGraphNode, adapter: Option<BoxAdapter>): string => {
    const role = node.label.replace(/ [0-9a-f]{4}$/, "")
    return adapter.match({
        none: () => role === "master-sum" ? "master sum" : role,
        some: adapter => {
            if (adapter instanceof AuxSendBoxAdapter) {
                return `send → ${adapter.optTargetBus.mapOr(bus => bus.labelField.getValue(), "?")}`
            }
            if (role.startsWith("strip:")) {return "channel strip"}
            if (role.startsWith("bus-sum")) {return "bus sum"}
            if (Devices.isAny(adapter) && !(adapter instanceof AudioUnitBoxAdapter)) {return adapter.labelField.getValue()}
            return role
        }
    })
}

const layout = (project: Project, graph: SignalGraph): Layout => {
    const predecessors = new Map<int, Array<SignalGraphEdge>>(graph.nodes.map(node => [node.id, []]))
    const successors = new Map<int, Array<SignalGraphEdge>>(graph.nodes.map(node => [node.id, []]))
    graph.edges.forEach(edge => {
        predecessors.get(edge.target)?.push(edge)
        successors.get(edge.source)?.push(edge)
    })
    const depths = new Map<int, int>()
    const depthOf = (id: int): int => {
        const known = depths.get(id)
        if (isDefined(known)) {return known}
        depths.set(id, 0) // a sidechain from downstream closes a cycle
        const depth = (predecessors.get(id) ?? []).reduce((max, edge) => Math.max(max, depthOf(edge.source) + 1), 0)
        depths.set(id, depth)
        return depth
    }
    const nodes = [...graph.nodes].sort((left, right) => depthOf(left.id) - depthOf(right.id))
    const adapters = new Map(nodes.map(node => [node.id, adapterOf(project, node.owner)]))
    const output = project.rootBoxAdapter.audioUnits.adapters().find(unit => unit.isOutput)
    const lanes = new Map<int, Lane>()
    nodes.forEach(node => {
        const unit = adapters.get(node.id)?.flatMap(unitOf) ?? Option.None
        if (unit.nonEmpty()) {
            lanes.set(node.id, laneOf(unit.unwrap()))
        } else if (node.label === "master-sum" && isDefined(output)) {
            lanes.set(node.id, laneOf(output))
        }
    })
    const inherit = (node: SignalGraphNode, edges: ReadonlyArray<SignalGraphEdge>, end: (edge: SignalGraphEdge) => int) => {
        if (lanes.has(node.id)) {return}
        const source = edges.find(edge => edge.data && lanes.has(end(edge)))
        if (isDefined(source)) {lanes.set(node.id, lanes.get(end(source)) ?? OTHER_LANE)}
    }
    nodes.forEach(node => inherit(node, predecessors.get(node.id) ?? [], edge => edge.source))
    nodes.toReversed().forEach(node => inherit(node, successors.get(node.id) ?? [], edge => edge.target))
    const laneByKey = new Map<string, { lane: Lane, nodes: Array<SignalGraphNode> }>()
    nodes.forEach(node => {
        const lane = lanes.get(node.id) ?? OTHER_LANE
        const entry = laneByKey.get(lane.key) ?? {lane, nodes: []}
        entry.nodes.push(node)
        laneByKey.set(lane.key, entry)
    })
    const ordered = Array.from(laneByKey.values()).sort((left, right) =>
        Number(left.lane.output) - Number(right.lane.output)
        || depthOf(left.nodes[0].id) - depthOf(right.nodes[0].id)
        || left.lane.label.localeCompare(right.lane.label))
    const placed = new Map<int, Placed>()
    const rows = new Map<int, number>()
    const bands: Array<LaneBand> = []
    const cursor = {y: 0}
    ordered.forEach(({lane, nodes: laneNodes}) => {
        const columns = new Map<int, Array<SignalGraphNode>>()
        laneNodes.forEach(node => columns.set(depthOf(node.id), [...(columns.get(depthOf(node.id)) ?? []), node]))
        const weight = (node: SignalGraphNode): number => {
            const sources = (predecessors.get(node.id) ?? []).map(edge => rows.get(edge.source)).filter(isDefined)
            return sources.length === 0 ? 0 : sources.reduce((sum, row) => sum + row, 0) / sources.length
        }
        const height = Math.max(...Array.from(columns.values()).map(column => column.length))
            * (NODE_HEIGHT + ROW_GAP) - ROW_GAP + LANE_PADDING * 2
        Array.from(columns.entries()).sort(([left], [right]) => left - right).forEach(([depth, column]) => {
            column
                .sort((left, right) => weight(left) - weight(right) || left.label.localeCompare(right.label))
                .forEach((node, row) => {
                    rows.set(node.id, row)
                    placed.set(node.id, {
                        node,
                        title: titleOf(node, adapters.get(node.id) ?? Option.None),
                        x: LANE_HEADER + depth * (NODE_WIDTH + COLUMN_GAP),
                        y: cursor.y + LANE_PADDING + row * (NODE_HEIGHT + ROW_GAP)
                    })
                })
        })
        bands.push({lane, y: cursor.y, height})
        cursor.y += height
    })
    const width = Array.from(placed.values()).reduce((max, {x}) => Math.max(max, x + NODE_WIDTH + COLUMN_GAP), 0)
    return {placed, bands, width, height: cursor.y}
}

const renderGraph = (project: Project, graph: SignalGraph): SVGSVGElement => {
    const millis = (frames: int): string => `${(frames / graph.sampleRate * 1000).toFixed(2)} ms`
    const {placed, bands, width, height} = layout(project, graph)
    const edgeElements: Array<{ edge: SignalGraphEdge, element: SVGGElement }> = []
    const nodeElements = new Map<int, SVGGElement>()
    const labels: Array<SVGGElement> = []
    const svg: SVGSVGElement = (
        <svg width={String(width)} height={String(height)} viewBox={`0 0 ${width} ${height}`}>
            <defs>
                <marker id="signal-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7"
                        orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" fill="context-stroke"/>
                </marker>
            </defs>
        </svg>
    )
    bands.forEach(({lane, y, height: bandHeight}, index) => svg.appendChild(
        <g classList={Html.buildClassList("lane", index % 2 === 1 && "odd")}>
            <rect x="0" y={String(y)} width={String(width)} height={String(bandHeight)}/>
            <text x="10" y={String(y + LANE_PADDING + 14)}>{lane.label}</text>
        </g>
    ))
    graph.edges.forEach(edge => {
        const source = placed.get(edge.source)
        const target = placed.get(edge.target)
        if (!isDefined(source) || !isDefined(target)) {return}
        const x0 = source.x + NODE_WIDTH
        const y0 = source.y + NODE_HEIGHT / 2
        const x1 = target.x - 2
        const y1 = target.y + NODE_HEIGHT / 2
        const bend = Math.max(24, (x1 - x0) / 2)
        const exceeded = edge.delay > graph.maxCompensation
        const element: SVGGElement = (
            <g classList={Html.buildClassList("edge", edge.data ? "data" : "order",
                edge.delay > 0 && "delayed", exceeded && "exceeded")}>
                <path d={y0 === y1 ? `M${x0},${y0} L${x1},${y1}` : `M${x0},${y0} C${x0 + bend},${y0} ${x1 - bend},${y1} ${x1},${y1}`}
                      marker-end="url(#signal-arrow)"/>
            </g>
        )
        if (edge.delay > 0) {
            const text = `+${edge.delay} · ${millis(edge.delay)}`
            const labelWidth = text.length * 6 + 10
            labels.push(
                <g classList={Html.buildClassList("delay-label", exceeded && "exceeded")}
                   transform={`translate(${x1 - 8 - labelWidth}, ${y1 - 18})`}>
                    <rect width={String(labelWidth)} height="14" rx="7"/>
                    <text x={String(labelWidth / 2)} y="10" text-anchor="middle">{text}</text>
                </g>
            )
        }
        edgeElements.push({edge, element})
        svg.appendChild(element)
    })
    const focus = (id: int) => {
        svg.classList.add("focus")
        nodeElements.get(id)?.classList.add("active")
        edgeElements
            .filter(({edge}) => edge.source === id || edge.target === id)
            .forEach(({edge, element}) => {
                element.classList.add("active")
                nodeElements.get(edge.source === id ? edge.target : edge.source)?.classList.add("active")
            })
    }
    const blur = () => {
        svg.classList.remove("focus")
        svg.querySelectorAll(".active").forEach(element => element.classList.remove("active"))
    }
    placed.forEach(({node, title, x, y}) => {
        const timing = node.arrival > 0
            ? `latency ${node.latency} · arrives +${node.arrival} (${millis(node.arrival)})`
            : `latency ${node.latency}`
        const element: SVGGElement = (
            <g classList={Html.buildClassList("node", node.latency > 0 && "latent")}
               transform={`translate(${x}, ${y})`}
               onmouseenter={() => focus(node.id)}
               onmouseleave={blur}>
                <title>{`#${node.id} ${node.label}`}</title>
                <rect width={String(NODE_WIDTH)} height={String(NODE_HEIGHT)} rx="3"/>
                <text className="name" x="8" y="15">{title}</text>
                <text className="timing" x="8" y="30">{timing}</text>
            </g>
        )
        nodeElements.set(node.id, element)
        svg.appendChild(element)
    })
    labels.forEach(label => svg.appendChild(label))
    return svg
}

export const SignalGraphPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const summary: HTMLElement = <p className="summary"/>
    const canvas: HTMLElement = <div className="canvas"/>
    const element: DomElement = (
        <div className={className}>
            {service.projectProfileService.getValue().match({
                none: () => (
                    <Frag>
                        <h1>Signal Graph</h1>
                        <p onclick={() => service.closeProject()}
                           style={{color: Colors.dark.toString(), cursor: "pointer"}}>Open a project first...</p>
                    </Frag>
                ),
                some: ({project, meta}) => {
                    const state = {snapshot: ""}
                    const refresh = () => service.engine.querySignalGraph().then(graph => {
                        const snapshot = JSON.stringify(graph)
                        if (snapshot === state.snapshot) {return}
                        state.snapshot = snapshot
                        const master = graph.nodes.reduce((max, node) => Math.max(max, node.arrival), 0)
                        summary.textContent = `${graph.nodes.length} processors · ${graph.edges.length} edges · `
                            + `longest path ${master} frames · max compensation ${graph.maxCompensation} frames`
                        Html.empty(canvas)
                        canvas.appendChild(renderGraph(project, graph))
                    })
                    refresh()
                    lifecycle.own(Runtime.scheduleInterval(refresh, POLL_INTERVAL_MS))
                    return (
                        <Frag>
                            <h1>Signal Graph '{meta.name}'</h1>
                            {summary}
                            <p className="legend">
                                One band per audio unit. Solid arrows carry audio, dashed arrows only order the render
                                (sidechain). A compensation delay is written at the input it delays. Hover a processor
                                to trace its connections.
                            </p>
                            {canvas}
                        </Frag>
                    )
                }
            })}
        </div>
    )
    return element
}
