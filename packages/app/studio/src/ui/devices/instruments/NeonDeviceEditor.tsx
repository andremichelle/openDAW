import css from "./NeonDeviceEditor.sass?inline"
import {Lifecycle, tryCatch} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {CzSysex, DeviceHost, InstrumentFactories, NeonDeviceBoxAdapter, NeonPreset} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NeonDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NeonDeviceBoxAdapter
    deviceHost: DeviceHost
}

// The first editor iteration (plans/neon.md): load a Casio CZ .syx tone and play. The full parameter
// layout (line strips, envelope widgets) follows in a later phase.
export const NeonDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const presetName: HTMLElement = (<span className="preset-name"/>)
    const loadPreset = async () => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "Casio CZ SysEx", accept: {"application/octet-stream": [".syx"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const bytes = new Uint8Array(await file.arrayBuffer())
        const decoded = tryCatch(() => CzSysex.decode(bytes))
        if (decoded.status === "failure") {
            console.warn("Not a Casio CZ tone dump:", file.name, decoded.error)
            return
        }
        const name = file.name.replace(/\.syx$/i, "")
        editing.modify(() => {
            NeonPreset.apply(adapter.box, decoded.value)
            adapter.box.label.setValue(name)
        })
    }
    const loadButton: HTMLElement = (
        <span className="load" onclick={loadPreset}>
            <Icon symbol={IconSymbol.Browse}/>
        </span>
    )
    lifecycle.ownAll(
        TextTooltip.default(loadButton, () => "Load a Casio CZ .syx tone"),
        adapter.labelField.catchupAndSubscribe(owner => presetName.textContent = owner.getValue())
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="preset-row">
                                  {presetName}
                                  {loadButton}
                              </div>
                              <div className="hint">Phase distortion · load a CZ-101 .syx preset</div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Neon.defaultIcon}/>
    )
}
