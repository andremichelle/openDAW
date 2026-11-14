import css from "./OpenDrumDeviceEditor.sass?inline"
import {Color, EmptyExec, Lifecycle, Option, Provider} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter, DeviceHost, InstrumentDeviceBoxAdapter} from "@opendaw/studio-adapters"
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

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: InstrumentDeviceBoxAdapter
    deviceHost: DeviceHost
    sections: ReadonlyArray<OpenDrumSection>
    request: Provider<OpenDrumSynth.Request>
    color: Color
    icon: IconSymbol
}

const Rows = 4

export const OpenDrumDeviceEditor = ({lifecycle, service, adapter, deviceHost, sections, request, color, icon}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const createControl = (parameter: AutomatableParameterFieldAdapter<number>, column: number, row: number) => (
        <div className="control" style={{gridArea: `${row * 2 + 2} / ${column + 2} / ${row * 2 + 4} / ${column + 3}`}}>
            <h3>{parameter.name}</h3>
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
            .forEach((parameter, row) => groups.push(createControl(parameter, column + offset, row))))
        column += columns.length
    }
    const canvas: HTMLCanvasElement = <canvas/>
    let picture: Option<OpenDrumSynth.Picture> = Option.None
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight, devicePixelRatio}) => {
        const width = actualWidth * devicePixelRatio
        const height = actualHeight * devicePixelRatio
        context.clearRect(0, 0, width, height)
        picture.ifSome(current => OpenDrumDisplay.paint(context, width, height, devicePixelRatio, current, color))
    }))
    // one render at a time, a change meanwhile renders the current values once it is done
    const closing = new AbortController()
    // a worker of its own for this editor, ended with it
    const renderer = OpenDrumSynth.start()
    let rendering = false
    let outdated = false
    let requested = ""
    // the display is optional: without the worker it stays empty, the device plays the same
    const update = (): void => {
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
        renderer
            .then(loaded => loaded.picture(next, closing.signal))
            .then(result => {
                picture = Option.wrap(result)
                painter.requestUpdate()
            }, (error: unknown) => {
                if (!closing.signal.aborted) {console.debug("openDrum display", error)}
            })
            .finally(() => {
                rendering = false
                if (outdated && !closing.signal.aborted) {update()}
            })
    }
    sections.forEach(({columns}) => columns.forEach(parameters => parameters
        .forEach(parameter => lifecycle.own(parameter.subscribe(update)))))
    lifecycle.own({
        terminate: () => {
            closing.abort()
            renderer.then(loaded => loaded.terminate(), EmptyExec)
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
