import css from "./TubularDeviceEditor.sass?inline"
import {DefaultObservableValue, int, Lifecycle, Terminator, tryCatch} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {createElement, JsxValue, replaceChildren} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, Dx7Sysex, InstrumentFactories, Tubular, TubularDeviceBoxAdapter, TubularPreset} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {MenuItem} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {OutSection} from "@/ui/devices/instruments/TubularDeviceEditor/OutSection"
import {OperatorSection} from "@/ui/devices/instruments/TubularDeviceEditor/OperatorSection"
import {AlgorithmSection} from "@/ui/devices/instruments/TubularDeviceEditor/AlgorithmSection"
import {LfoSection} from "@/ui/devices/instruments/TubularDeviceEditor/LfoSection"
import {PitchSection} from "@/ui/devices/instruments/TubularDeviceEditor/PitchSection"
import {TubularCartridge, TubularCartridges} from "@/ui/devices/instruments/TubularDeviceEditor/TubularCartridges"
import {TubularAudition} from "@/ui/devices/instruments/TubularDeviceEditor/TubularAudition"

const className = Html.adoptStyleSheet(css, "TubularDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: TubularDeviceBoxAdapter
    deviceHost: DeviceHost
}

// plans/tubular-editor.md: a 2 × 5 grid of round tab buttons (OP 1-6, ALGO, LFO, PITCH, OUT) on the left,
// the selected section on the right. The tab state is shared across instances and starts on OUT.
type Tab = {label: string, group: string, glyph: () => HTMLElement | SVGSVGElement}
const TABS: ReadonlyArray<Tab> = [
    ...Array.from({length: 6}, (_, index): Tab => ({label: `Operator ${index + 1}`, group: "op", glyph: () => <span>{String(index + 1)}</span>})),
    {label: "Algorithm", group: "algo", glyph: () => <Icon symbol={IconSymbol.Chain}/>},
    {label: "LFO", group: "lfo", glyph: () => <Icon symbol={IconSymbol.Sine}/>},
    {label: "Pitch Envelope", group: "pitch", glyph: () => <Icon symbol={IconSymbol.Adsr}/>},
    {label: "Output", group: "out", glyph: () => <Icon symbol={IconSymbol.Volume}/>}
]
const DEFAULT_TAB = TABS.length - 1
// Shared by every Tubular editor instance: a preset load replaces the device box (and its editor), the
// selected tab must survive that.
const selectedTab = new DefaultObservableValue<int>(DEFAULT_TAB)

export const TubularDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const box = adapter.box
    const cartridges = TubularCartridges.get()
    cartridges.load().catch(console.warn)
    const applyVoice = (cartridge: TubularCartridge, index: int): void => {
        const voice = cartridge.voices[index]
        editing.modify(() => TubularPreset.apply(box, voice.data))
    }
    const sectionLifecycle = lifecycle.own(new Terminator())
    const sectionConstruct = () => ({lifecycle: sectionLifecycle, service, adapter, selectTab: (index: int) => tab.setValue(index)})
    const SECTIONS: Record<string, (index: int) => JsxValue> = {
        op: index => OperatorSection(sectionConstruct(), index),
        algo: () => AlgorithmSection(sectionConstruct()),
        lfo: () => LfoSection(sectionConstruct()),
        pitch: () => PitchSection(sectionConstruct()),
        out: () => OutSection(sectionConstruct())
    }
    const loadFile = async (): Promise<void> => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "DX7 SysEx", accept: {"application/octet-stream": [".syx"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const bytes = new Uint8Array(await file.arrayBuffer())
        const decoded = tryCatch(() => Dx7Sysex.decode(bytes))
        if (decoded.status === "failure") {
            console.warn("Not a DX7 dump:", file.name, decoded.error)
            return
        }
        editing.modify(() => TubularPreset.apply(box, decoded.value[0].data))
    }
    const audition = (): void => cartridges.loaded.ifSome(list =>
        TubularAudition.open({service, adapter, cartridges: list, start: {bank: 0, index: 0}, applyVoice}).catch(console.warn))
    const tab = selectedTab
    const tabs: ReadonlyArray<HTMLElement> = TABS.map(({label, group, glyph}, index) => {
        const element: HTMLElement = <div className={`tab ${group}`} onclick={() => tab.setValue(index)}>{glyph()}</div>
        lifecycle.own(TextTooltip.default(element, () => label))
        return element
    })
    const section: HTMLElement = <section/>
    lifecycle.own(tab.catchupAndSubscribe(owner => {
        const selected = owner.getValue()
        tabs.forEach((element, index) => element.classList.toggle("selected", index === selected))
        section.className = TABS[selected].group
        sectionLifecycle.terminate()
        replaceChildren(section, SECTIONS[TABS[selected].group](selected))
    }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Engine", separatorBefore: true})
                              .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...Tubular.Engines.map((label, index) =>
                                  MenuItem.default({label, checked: box.engine.getValue() === index})
                                      .setTriggerProcedure(() => editing.modify(() => box.engine.setValue(index)))))))
                          parent.addMenuItem(MenuItem.default({label: "Audition cartridges…", separatorBefore: true, selectable: cartridges.loaded.nonEmpty()})
                              .setTriggerProcedure(audition))
                          parent.addMenuItem(MenuItem.default({label: "Load DX7 .syx…"})
                              .setTriggerProcedure(() => {loadFile().catch(console.warn)}))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <nav>{tabs}</nav>
                              {section}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Tubular.defaultIcon}/>
    )
}
