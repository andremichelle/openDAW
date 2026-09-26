import css from "./AlgorithmSection.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@opendaw/studio-core"
import {Tubular} from "@opendaw/studio-adapters"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {radioCell, SectionConstruct, sectionKnob} from "./SectionControls"

const className = Html.adoptStyleSheet(css, "AlgorithmSection")

type Placed = {x: number, depth: number}

// Positions for the six operators of an algorithm: carriers on the bottom row in panel order, every
// modulator one row above its lowest target, centred over its targets and pushed right on collisions.
const place = (roles: ReadonlyArray<Tubular.OperatorRole>): ReadonlyArray<Placed> => {
    const depth = roles.map(() => -1)
    for (let pass = 0; pass < 6; pass++) {
        roles.forEach((role, op) => {
            if (role.carrier) {
                depth[op] = 0
            } else if (role.targets.every(target => depth[target - 1] >= 0)) {
                depth[op] = 1 + Math.max(...role.targets.map(target => depth[target - 1]))
            }
        })
    }
    const x = roles.map(() => 0.0)
    const maxDepth = Math.max(...depth)
    for (let level = 0; level <= maxDepth; level++) {
        const ops = roles.map((_, op) => op).filter(op => depth[op] === level)
        const desired = ops.map(op => level === 0
            ? ops.indexOf(op)
            : roles[op].targets.reduce((sum, target) => sum + x[target - 1], 0.0) / roles[op].targets.length)
        const order = ops.map((op, index) => ({op, want: desired[index]})).sort((a, b) => a.want - b.want)
        let cursor = -Infinity
        order.forEach(({op, want}) => {
            const placed = Math.max(want, cursor + 1.0)
            x[op] = placed
            cursor = placed
        })
    }
    return roles.map((_, op) => ({x: x[op], depth: depth[op]}))
}

// The algorithm as a drawn diagram (from Tubular.roles), Feedback and Osc key sync, and an overview of all
// six operators (jump, Level, Switch) so carriers and modulators balance without tab hopping.
export const AlgorithmSection = (construct: SectionConstruct) => {
    const {lifecycle, service, adapter, selectTab} = construct
    const {editing} = service.project
    const {algorithm, feedback, oscKeySync, operators} = adapter.namedParameter
    const canvas: HTMLCanvasElement = <canvas/>
    const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painter
        const roles = Tubular.roles(algorithm.getValue())
        const placed = place(roles)
        const columns = Math.max(...placed.map(entry => entry.x)) + 1
        const rows = Math.max(...placed.map(entry => entry.depth)) + 1
        const box = devicePixelRatio * 14
        const padding = devicePixelRatio * 8
        const slotX = (actualWidth - padding * 2) / Math.max(columns, 3)
        const slotY = (actualHeight - padding * 2) / Math.max(rows, 3)
        const centre = (op: number): [number, number] => [
            padding + slotX * (placed[op].x + 0.5) + (Math.max(columns, 3) - columns) * slotX * 0.5,
            actualHeight - padding - slotY * (placed[op].depth + 0.5)
        ]
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.lineWidth = devicePixelRatio
        context.strokeStyle = DisplayPaint.strokeStyle(0.5)
        context.beginPath()
        roles.forEach((role, op) => {
            const [x, y] = centre(op)
            role.targets.forEach(target => {
                const [tx, ty] = centre(target - 1)
                context.moveTo(x, y + box / 2)
                context.lineTo(tx, ty - box / 2)
            })
            if (role.carrier) {
                context.moveTo(x, y + box / 2)
                context.lineTo(x, actualHeight - padding * 0.5)
            }
            if (role.feedback) {
                context.moveTo(x + box / 2, y)
                context.arc(x + box / 2 + devicePixelRatio * 3, y, devicePixelRatio * 3, Math.PI, Math.PI * 3, false)
            }
        })
        context.moveTo(padding * 0.5, actualHeight - padding * 0.5)
        context.lineTo(actualWidth - padding * 0.5, actualHeight - padding * 0.5)
        context.stroke()
        context.font = `${devicePixelRatio * 9}px sans-serif`
        context.textAlign = "center"
        context.textBaseline = "middle"
        roles.forEach((role, op) => {
            const [x, y] = centre(op)
            context.fillStyle = role.carrier ? DisplayPaint.strokeStyle(0.9) : DisplayPaint.strokeStyle(0.35)
            context.beginPath()
            context.roundRect(x - box / 2, y - box / 2, box, box, devicePixelRatio * 2)
            context.fill()
            context.fillStyle = "rgba(0, 0, 0, 0.85)"
            context.fillText(String(op + 1), x, y + devicePixelRatio * 0.5)
        })
    }))
    lifecycle.own(algorithm.subscribe(() => painter.requestUpdate()))
    const jumpCell = (index: number): HTMLElement => (
        <div className="cell jump">
            <h5>{`OP ${index + 1}`}</h5>
            <span className="jump" onclick={() => selectTab(index)}>EDIT</span>
        </div>
    )
    return (
        <div className={className}>
            {sectionKnob(construct, algorithm)}
            {sectionKnob(construct, feedback)}
            {radioCell(lifecycle, "Osc Sync", EditWrapper.forAutomatableParameter(editing, oscKeySync), ["OFF", "ON"])}
            {operators.map((_, index) => jumpCell(index))}
            <div className="diagram">{canvas}</div>
            {operators.map((operator, index) => sectionKnob(construct, operator.outputLevel, `OP ${index + 1} Level`))}
            {operators.map(operator => radioCell(lifecycle, "Switch", EditWrapper.forAutomatableParameter(editing, operator.enabled), ["OFF", "ON"]))}
        </div>
    )
}
