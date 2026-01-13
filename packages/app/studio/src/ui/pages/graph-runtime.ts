// graph-runtime.ts
import ForceGraph from "force-graph"
import * as d3 from "d3-force"
import {SimulationNodeDatum} from "d3-force"
import {isUndefined, unitValue} from "@moises-ai/lib-std"

type Node = {
    id: string; label?: string, root?: boolean, fx?: number, fy?: number
} & SimulationNodeDatum

type Edge = { source: string; target: string }

export type GraphData = {
    nodes: Array<Node>
    edges: Array<Edge>
}

export type CreateGraphPanel =
    (canvas: HTMLCanvasElement, data: GraphData, opts?: { dark?: boolean }) => {
        terminate(): void
        resize(): void
    }

export const GRAPH_INTERACTION_HINT =
    "Drag nodes to reposition. Scroll to zoom. Drag background to pan. Hover a node to see its name."

const stringToUnit = (value: string): unitValue =>
    Array.from(value).reduce((h, char) => (h * 31 + char.charCodeAt(0)) >>> 0, 0) / 0xffffffff

export const createGraphPanel: CreateGraphPanel = (canvas, data, opts = {}) => {
    const dark = !!opts.dark

    const nodes = data.nodes
    const links = data.edges

    let hovered: any = null

    const graph = new ForceGraph<Node, Edge>(canvas)
        .graphData({nodes, links})
        .backgroundColor(dark ? "#0e0f12" : "#ffffff")
        .nodeId("id")
        .linkSource("source")
        .linkTarget("target")
        .nodeRelSize(6)
        .enableNodeDrag(true)
        .autoPauseRedraw(false)
        .linkColor(() => (dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)"))
        .linkWidth(1)
        .nodeVal(({root}: Node) => root ? 48 : 3)
        .nodeColor((n: Node) => {
            const hue = stringToUnit(n.label ?? "")
            return `hsl(${hue * 360}, 75%, 50%)`
        })
        // draw labels ourselves on top:
        .nodeCanvasObjectMode(() => "after")
        .nodeCanvasObject((_node: any, _ctx: CanvasRenderingContext2D) => {
            /* labels drawn in onRenderFramePost */
        })
        // update hover state
        .onNodeHover((node: any) => hovered = node || null)

    graph.onRenderFramePost((ctx: CanvasRenderingContext2D) => {
        const zoom: number = graph.zoom?.()
        const threshold = 1.2

        const drawPill = (x: number, y: number, text: string) => {
            const padX = 6
            const padY = 3
            const tw = ctx.measureText(text).width
            const w = tw + padX * 2
            const h = 16 + padY * 2
            const rx = 6
            ctx.beginPath()
            ctx.moveTo(x - w / 2 + rx, y - h / 2)
            ctx.lineTo(x + w / 2 - rx, y - h / 2)
            ctx.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + rx)
            ctx.lineTo(x + w / 2, y + h / 2 - rx)
            ctx.quadraticCurveTo(x + w / 2, y + h / 2, x + w / 2 - rx, y + h / 2)
            ctx.lineTo(x - w / 2 + rx, y + h / 2)
            ctx.quadraticCurveTo(x - w / 2, y + h / 2, x - w / 2, y + h / 2 - rx)
            ctx.lineTo(x - w / 2, y - h / 2 + rx)
            ctx.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + rx, y - h / 2)
            ctx.closePath()
            ctx.fillStyle = dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.8)"
            ctx.fill()
            ctx.strokeStyle = dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)"
            ctx.stroke()
            ctx.fillStyle = dark ? "#ffffff" : "#000000"
            ctx.fillText(text, x, y)
        }

        ctx.save()
        const fontSize = 12 / zoom
        ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillStyle = "#ffffff"

        const g = graph.graphData() as { nodes: Array<Node> }

        if (zoom >= threshold) {
            for (const node of g.nodes) {
                if (isUndefined(node.label) || isUndefined(node.x) || isUndefined(node.y)) {continue}
                ctx.fillText(node.label, node.x, node.y)
            }
        }
        if (hovered && typeof hovered.x === "number" && typeof hovered.y === "number") {
            const text = hovered.label ?? hovered.id
            drawPill(hovered.x, hovered.y - 18 / zoom, text)
        }
        ctx.restore()
    })

    graph
        .d3Force("charge", d3.forceManyBody().strength(-150))
        .d3Force("link", d3.forceLink<Node, Edge>()
            .id((n: Node) => n.id)
            .distance(70)
            .strength(0.8)
        )
        .d3Force("center", d3.forceCenter(0, 0))

    const applySize = () => {
        const {width, height} = canvas.getBoundingClientRect()
        graph.width(width).height(height)
    }
    const resizeObserver = new ResizeObserver(applySize)
    resizeObserver.observe(canvas)
    applySize()
    return {
        terminate(): void {
            try { resizeObserver.disconnect() } catch {}
            try { graph.graphData({nodes: [], links: []}) } catch {}
            graph._destructor()
        },
        resize(): void {
            applySize()
        }
    }
}
