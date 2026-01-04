import css from "./DelayDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DelayDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {int, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"

const className = Html.adoptStyleSheet(css, "DelayDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: DelayDeviceBoxAdapter
    deviceHost: DeviceHost
}

type Control = {
    lifecycle: Lifecycle
    parameter: AutomatableParameterFieldAdapter<number>
    name?: string
    grid: { u: int, v: int }
    threshold?: number | ReadonlyArray<number>
}

export const DelayDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {preSyncTimeLeft, preMillisTimeLeft, preSyncTimeRight, preMillisTimeRight} = adapter.namedParameter
    const createLabelControlFrag = ({lifecycle, parameter, name, grid: {u, v}, threshold}: Control) => (
        <div className="control" style={{gridArea: `${v + 1}/${u + 1}`}}>
            <h3>{name ?? parameter.name}</h3>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       options={isDefined(threshold) ? {snap: {threshold}} : undefined}
                                       supressValueFlyout={true}>
                <ParameterLabel lifecycle={lifecycle}
                                editing={editing}
                                midiLearning={midiLearning}
                                adapter={adapter}
                                parameter={parameter}
                                classList={["center"]}
                                framed={true} standalone/>
            </RelativeUnitValueDragging>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <h3 style={{gridArea: "1 / 1 / 3 / 2"}}>PRE DELAY L</h3>
                              <h3 style={{gridArea: "4 / 1 / 6 / 2"}}>PRE DELAY R</h3>
                              {[
                                  createLabelControlFrag({
                                      lifecycle: lifecycle,
                                      parameter: preSyncTimeLeft,
                                      name: "sync",
                                      grid: {u: 1, v: 0}
                                  }),
                                  createLabelControlFrag({
                                      lifecycle: lifecycle,
                                      parameter: preMillisTimeLeft,
                                      name: "millis",
                                      grid: {u: 1, v: 1}
                                  }),
                                  createLabelControlFrag({
                                      lifecycle: lifecycle,
                                      parameter: preSyncTimeRight,
                                      name: "sync",
                                      grid: {u: 1, v: 3}
                                  }),
                                  createLabelControlFrag({
                                      lifecycle: lifecycle,
                                      parameter: preMillisTimeRight,
                                      name: "millis",
                                      grid: {u: 1, v: 4}
                                  })
                              ]}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Delay.defaultIcon}/>
    )
}
