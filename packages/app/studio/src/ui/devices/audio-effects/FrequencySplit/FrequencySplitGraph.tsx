import css from "./FrequencySplitGraph.sass?inline"
import {asDefined, clamp, Editing, EmptyExec, Lifecycle, Strings, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {FrequencySplitBoxAdapter} from "@opendaw/studio-adapters"
import {LinearScale, LogScale, Project} from "@opendaw/studio-core"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Surface} from "@/ui/surface/Surface"
import {plotSpectrum} from "@/ui/devices/audio-effects/Revamp/Renderer.ts"

const className = Html.adoptStyleSheet(css, "FrequencySplitGraph")

const spectrumScale = new LinearScale(-60.0, -3.0)

export const GAP = 0.06

const xAxis = new LogScale(20.0, 20_000.0)
const FREQ_UNITS = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000] as const

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    project: Project
    adapter: FrequencySplitBoxAdapter
}

export const FrequencySplitGraph = ({lifecycle, editing, project, adapter}: Construct) => {
    const spectrum: HTMLCanvasElement = <canvas className="spectrum"/>
    const spectrumContext = asDefined(spectrum.getContext("2d"))
    const overlay: HTMLElement = <div className="overlay"/>
    const plot: HTMLElement = <div className="plot">{spectrum}{overlay}</div>
    const axis: SVGSVGElement = <svg className="axis"/>
    const element: HTMLElement = <div className={className}>{axis}{plot}</div>
    lifecycle.own(project.liveStreamReceiver.subscribeFloats(adapter.spectrum, values =>
        plotSpectrum(spectrumContext, xAxis, spectrumScale, values, project.engine.sampleRate)))
    const rebuildLifecycle = lifecycle.own(new Terminator())
    const boundsOf = (index: number, count: number): [number, number] => [
        (index > 0 ? adapter.crossover[index - 1].getUnitValue() : 0.0) + GAP,
        (index < count - 1 ? adapter.crossover[index + 1].getUnitValue() : 1.0) - GAP
    ]
    const rebuild = () => {
        rebuildLifecycle.terminate()
        Html.empty(overlay)
        const count = adapter.crossoverCount
        const bandLabels = Array.from({length: count + 1}, (_, band) => {
            const label: HTMLElement = <span className="band-number">{String(band + 1)}</span>
            overlay.appendChild(label)
            return label
        })
        const placeBands = () => {
            const edges = [0.0, ...Array.from({length: count}, (_, index) => adapter.crossover[index].getUnitValue()), 1.0]
            bandLabels.forEach((label, band) => {
                label.style.left = `${((edges[band] + edges[band + 1]) / 2) * 100}%`
            })
        }
        placeBands()
        Array.from({length: count}, (_, index) => index).forEach(index => {
            const parameter = adapter.crossover[index]
            const line: HTMLElement = <div className="crossover"/>
            const place = () => {
                line.style.left = `${parameter.getUnitValue() * 100}%`
                placeBands()
            }
            place()
            rebuildLifecycle.own(parameter.subscribe(place))
            rebuildLifecycle.own(installDrag(line, overlay, parameter, editing, () => boundsOf(index, count)))
            rebuildLifecycle.own(installValueEditor(line, parameter, editing, () => boundsOf(index, count)))
            overlay.appendChild(line)
        })
    }
    rebuild()
    lifecycle.ownAll(
        renderAxisLabels(axis),
        adapter.entries.subscribe({onAdd: rebuild, onRemove: rebuild, onReorder: rebuild})
    )
    return element
}

const renderAxisLabels = (svg: SVGSVGElement): Terminable =>
    Html.watchResize(svg, () => {
        if (!svg.isConnected) {return}
        const width = svg.clientWidth
        const height = svg.clientHeight
        Html.empty(svg)
        svg.appendChild(
            <g fill="rgba(255, 255, 255, 0.3)" font-size="7px">
                {FREQ_UNITS.map((hz, index, all) => {
                    const x = xAxis.unitToNorm(hz) * width
                    const anchor = index === 0 ? "start" : index === all.length - 1 ? "end" : "middle"
                    return <text x={String(x)} y={String(height - 2)}
                                 text-anchor={anchor}>{hz >= 1000 ? `${hz / 1000}k` : `${hz}`}</text>
                })}
            </g>
        )
    })

const installDrag = (line: HTMLElement, track: HTMLElement,
                     parameter: FrequencySplitBoxAdapter["crossover"][number],
                     editing: Editing, bounds: () => [number, number]): Terminable =>
    Events.subscribe(line, "pointerdown", (event: PointerEvent) => {
        event.stopPropagation()
        line.setPointerCapture(event.pointerId)
        const move = (moveEvent: PointerEvent) => {
            const rect = track.getBoundingClientRect()
            const [low, high] = bounds()
            const unit = clamp((moveEvent.clientX - rect.left) / rect.width, low, high)
            editing.modify(() => parameter.setUnitValue(unit), false)
        }
        const up = () => {
            line.removeEventListener("pointermove", move)
            line.removeEventListener("pointerup", up)
            editing.mark()
        }
        line.addEventListener("pointermove", move)
        line.addEventListener("pointerup", up)
    })

const installValueEditor = (line: HTMLElement,
                            parameter: FrequencySplitBoxAdapter["crossover"][number],
                            editing: Editing, bounds: () => [number, number]): Terminable =>
    Events.subscribeDblDwn(line, () => {
        const rect = line.getBoundingClientRect()
        const [low, high] = bounds()
        const printValue = parameter.getPrintValue()
        const resolvers = Promise.withResolvers<string>()
        resolvers.promise.then(value => {
            const withUnit = Strings.endsWithDigit(value) ? `${value}${printValue.unit}` : value
            editing.modify(() => {
                parameter.setPrintValue(withUnit)
                parameter.setUnitValue(clamp(parameter.getUnitValue(), low, high))
            })
            editing.mark()
        }, EmptyExec)
        Surface.get(line).flyout.appendChild(
            <FloatingTextInput position={{x: rect.left, y: rect.top + (rect.height >> 1)}}
                               value={printValue.value}
                               unit={printValue.unit}
                               numeric
                               resolvers={resolvers}/>
        )
    })
