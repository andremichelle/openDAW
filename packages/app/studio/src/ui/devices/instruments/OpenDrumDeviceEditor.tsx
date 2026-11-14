import css from "./OpenDrumDeviceEditor.sass?inline"
import {Color, EmptyExec, Func, Lifecycle, Option} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {
    AutomatableParameterFieldAdapter, DeviceHost, InstrumentDeviceBoxAdapter, OpenDrum
} from "@opendaw/studio-adapters"
import {CanvasPainter} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {OpenDrumSynth} from "@/ui/devices/instruments/OpenDrum/OpenDrumSynth"
import {OpenDrumDisplay} from "@/ui/devices/instruments/OpenDrum/OpenDrumDisplay"

const className = Html.adoptStyleSheet(css, "OpenDrumDeviceEditor")

/** A titled group of controls, one column of at most four per entry in `columns`. */
export type OpenDrumSection = {
    readonly title: string
    readonly color: Color
    readonly columns: ReadonlyArray<ReadonlyArray<AutomatableParameterFieldAdapter<number>>>
}

type Value = (parameter: AutomatableParameterFieldAdapter<number>) => number

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: InstrumentDeviceBoxAdapter
    deviceHost: DeviceHost
    engine: OpenDrumSynth.Engine
    parameters: ReadonlyArray<AutomatableParameterFieldAdapter<number>>
    contour: Func<Value, OpenDrumSynth.Contour>
    sections: ReadonlyArray<OpenDrumSection>
    icon: IconSymbol
}

const Rows = 4

export const OpenDrumDeviceEditor = ({
    lifecycle, service, adapter, deviceHost, engine, parameters, contour, sections, icon
}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    // "Noise Decay" shows as "Decay" under NOISE
    const shortName = (name: string, title: string): string =>
        name.toLowerCase().startsWith(`${title.toLowerCase()} `) ? name.slice(title.length + 1) : name
    const createControl = (parameter: AutomatableParameterFieldAdapter<number>, title: string, column: number,
                           row: number) => (
        <div className="control" style={{gridArea: `${row * 2 + 2} / ${column + 2} / ${row * 2 + 4} / ${column + 3}`}}>
            <h3>{shortName(parameter.name, title)}</h3>
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={deviceHost.audioUnitBoxAdapter().tracks}
                               parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle}
                                           editing={editing}
                                           parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle}
                                    parameter={parameter}
                                    classList={["center"]}
                                    framed={true}/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        </div>
    )
    const groups: Array<Element> = []
    let column = 0
    for (const {title, color: sectionColor, columns} of sections) {
        const area = `1 / ${column + 2} / -1 / ${column + 2 + columns.length}`
        groups.push(<section style={{gridArea: area, "--color": sectionColor.toString()}}/>)
        groups.push(<h3 className="head" style={{gridArea: `1 / ${column + 2} / 2 / ${column + 2 + columns.length}`,
            "--color": sectionColor.toString()}}>{title}</h3>)
        columns.forEach((parameters, offset) => parameters.slice(0, Rows)
            .forEach((parameter, row) => groups.push(createControl(parameter, title, column + offset, row))))
        column += columns.length
    }
    const canvas: HTMLCanvasElement = <canvas/>
    let picture: Option<OpenDrumSynth.Picture> = Option.None
    let positions: Float32Array = new Float32Array([-1])
    let showing = false
    const painter = lifecycle.own(new CanvasPainter(canvas, painting => {
        const {context, actualWidth, actualHeight, devicePixelRatio} = painting
        context.clearRect(0, 0, actualWidth, actualHeight)
        picture.ifSome(current =>
            OpenDrumDisplay.paint(context, actualWidth, actualHeight, devicePixelRatio, current, positions))
    }))
    const now: Value = parameter => parameter.getControlledValue()
    const {engine: transport, tempoMap} = project
    const ordered = [...parameters].sort((first, second) => first.address.fieldKeys[0] - second.address.fieldKeys[0])
    const tempo = OpenDrumSynth.followsTempo(engine)
    const request = (): OpenDrumSynth.Request =>
        ({engine, values: ordered.map(now), bpm: tempo ? tempoMap.getTempoAt(transport.position.getValue()) : 120,
            contour: contour(now)})
    const closing = new AbortController()
    let renderer: Option<Promise<OpenDrumSynth.Renderer>> = Option.None
    const obtain = (): Promise<OpenDrumSynth.Renderer> => {
        if (renderer.isEmpty()) {
            const started = OpenDrumSynth.start()
            started.catch(() => renderer = Option.None)
            renderer = Option.wrap(started)
        }
        return renderer.unwrap()
    }
    let rendering = false
    let outdated = false
    let requested = ""
    let retried = false
    let stale = false
    const update = (): void => {
        if (stale) {return}
        if (rendering) {
            outdated = true
            return
        }
        const next = request()
        const key = OpenDrumSynth.keyOf(next)
        if (key === requested) {return}
        requested = key
        rendering = true
        outdated = false
        obtain()
            .then(loaded => loaded.picture(next, closing.signal))
            .then(result => {
                retried = false
                picture = Option.wrap(result)
                painter.requestUpdate()
            }, (error: unknown) => {
                requested = ""
                if (closing.signal.aborted) {return}
                if (error instanceof Error && error.message === OpenDrumSynth.OutOfDate) {
                    stale = true
                    console.warn(`openDrum display: ${OpenDrumSynth.OutOfDate}`)
                    return
                }
                console.debug("openDrum display", error)
                renderer.ifSome(started => started.then(loaded => loaded.terminate(), EmptyExec))
                renderer = Option.None
                if (!retried) {
                    retried = true
                    outdated = true
                }
            })
            .finally(() => {
                rendering = false
                if (outdated && !closing.signal.aborted) {scheduled.request()}
            })
    }
    const scheduled = lifecycle.own(deferNextFrame(update))
    parameters.forEach(parameter => lifecycle.own(parameter.subscribe(scheduled.request)))
    if (tempo) {
        lifecycle.own(tempoMap.subscribe(scheduled.request))
        lifecycle.own(transport.position.subscribe(scheduled.request))
    }
    lifecycle.own(project.liveStreamReceiver.subscribeFloats(adapter.address.append(OpenDrum.PositionsKey), values => {
        const sounding = values[0] >= 0.0
        if (!sounding && !showing) {return}
        showing = sounding
        positions = values
        painter.requestUpdate()
    }))
    lifecycle.own({
        terminate: () => {
            closing.abort()
            renderer.ifSome(started => started.then(loaded => loaded.terminate(), EmptyExec))
        }
    })
    update()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className} style={{"--columns": String(column)}}>
                              <header>{canvas}</header>
                              {groups}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={icon}/>
    )
}
