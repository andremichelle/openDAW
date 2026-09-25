import css from "./TubularDeviceEditor.sass?inline"
import {DefaultObservableValue, int, isDefined, Lifecycle, Option, tryCatch} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, Dx7Sysex, Dx7Voice, InstrumentFactories, TubularDeviceBoxAdapter, TubularPreset} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"
import {FlexSpacer} from "@/ui/components/FlexSpacer"
import {IconSymbol} from "@opendaw/studio-enums"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {TubularCartridge, TubularCartridges} from "@/ui/devices/instruments/TubularDeviceEditor/TubularCartridges"

const className = Html.adoptStyleSheet(css, "TubularDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: TubularDeviceBoxAdapter
    deviceHost: DeviceHost
}

// A cartridge the editor browses: bundled (with credits) or loaded from a .syx by the user.
type Bank = {
    readonly name: string
    readonly credits: Option<TubularCartridge>
    readonly voices: ReadonlyArray<Dx7Voice>
}

type Selection = {
    readonly bank: Bank
    readonly index: int
}

// Preset-first editor (plans/tubular.md phase 3): a cartridge browser over the bundled banks and user
// .syx files, previous / next voice, credits. The voice itself lives in the box, so the selection is
// only the editor's bookmark for browsing.
export const TubularDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const box = adapter.box
    const cartridges = TubularCartridges.get()
    const selection = lifecycle.own(new DefaultObservableValue<Option<Selection>>(Option.None))
    const loadedBanks: Array<Bank> = []
    const bankLabel: HTMLElement = <span/>
    const voiceLabel: HTMLElement = <span data-index=""/>
    const credits: HTMLElement = <div className="credits"/>
    const applyVoice = (bank: Bank, index: int): void => {
        const voice = bank.voices[index]
        if (!isDefined(voice)) {return}
        editing.modify(() => TubularPreset.apply(box, voice.data))
        selection.setValue(Option.wrap({bank, index}))
    }
    const bankOf = (cartridge: TubularCartridge): Bank =>
        ({name: cartridge.name, credits: Option.wrap(cartridge), voices: cartridge.voices})
    const step = (delta: int): void => selection.getValue().match({
        none: () => cartridges.loaded.ifSome(list => {
            if (list.length > 0) {applyVoice(bankOf(list[0]), 0)}
        }),
        some: ({bank, index}) => applyVoice(bank, (index + delta + bank.voices.length) % bank.voices.length)
    })
    cartridges.load().catch(console.warn)
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
        const bank: Bank = {name: file.name.replace(/\.syx$/i, ""), credits: Option.None, voices: decoded.value}
        loadedBanks.push(bank)
        applyVoice(bank, 0)
    }
    lifecycle.ownAll(
        selection.catchupAndSubscribe(owner => owner.getValue().match({
            none: () => {
                bankLabel.textContent = "Cartridges"
                voiceLabel.textContent = box.label.getValue()
                voiceLabel.dataset["index"] = ""
                credits.textContent = ""
            },
            some: ({bank, index}) => {
                bankLabel.textContent = bank.name
                voiceLabel.textContent = bank.voices[index].name
                voiceLabel.dataset["index"] = `#${index + 1}`
                credits.textContent = bank.credits.mapOr(cartridge => `${cartridge.author} · ${cartridge.license}`, "Loaded from file")
            }
        })),
        box.label.catchupAndSubscribe(field => {
            if (selection.getValue().isEmpty()) {voiceLabel.textContent = field.getValue()}
        })
    )
    const voiceItems = (bank: Bank): ReadonlyArray<MenuItem> => bank.voices.map((voice, index) =>
        MenuItem.default({
            label: `${String(index + 1).padStart(2, "0")}  ${voice.name}`,
            checked: selection.getValue().mapOr(current => current.bank === bank && current.index === index, false)
        }).setTriggerProcedure(() => applyVoice(bank, index)))
    const bankMenu = (parent: MenuItem): void => {
        parent.addMenuItem(MenuItem.default({label: "Bundled", icon: IconSymbol.CloudFolder, selectable: cartridges.loaded.nonEmpty()})
            .setRuntimeChildrenProcedure(parent => cartridges.loaded.ifSome(list => parent.addMenuItem(...list.map(cartridge =>
                MenuItem.default({label: cartridge.name})
                    .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...voiceItems(bankOf(cartridge)))))))))
        if (loadedBanks.length > 0) {
            parent.addMenuItem(MenuItem.default({label: "Loaded", icon: IconSymbol.UserFolder})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...loadedBanks.map(bank =>
                    MenuItem.default({label: bank.name})
                        .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...voiceItems(bank)))))))
        }
        parent.addMenuItem(MenuItem.default({label: "Load DX7 .syx…", separatorBefore: true})
            .setTriggerProcedure(() => {loadFile().catch(console.warn)}))
    }
    const previous: HTMLElement = <button className="step" onclick={() => step(-1)}><Icon symbol={IconSymbol.ArrowLeft}/></button>
    const next: HTMLElement = <button className="step" onclick={() => step(1)}><Icon symbol={IconSymbol.ArrowRight}/></button>
    lifecycle.ownAll(
        TextTooltip.default(previous, () => "Previous voice of the cartridge"),
        TextTooltip.default(next, () => "Next voice of the cartridge")
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Load DX7 .syx…", separatorBefore: true})
                              .setTriggerProcedure(() => {loadFile().catch(console.warn)}))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <FlexSpacer pixels={2}/>
                              <header>
                                  <Icon symbol={IconSymbol.Book}/>
                                  <h1>Cartridge</h1>
                              </header>
                              <div className="label">
                                  <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(bankMenu)}>
                                      {bankLabel}
                                  </MenuButton>
                              </div>
                              <FlexSpacer pixels={4}/>
                              <header>
                                  <Icon symbol={IconSymbol.Piano}/>
                                  <h1>Voice</h1>
                              </header>
                              <div className="label voice">
                                  {previous}
                                  <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                                      selection.getValue().match({
                                          none: () => bankMenu(parent),
                                          some: ({bank}) => parent.addMenuItem(...voiceItems(bank))
                                      }))}>
                                      {voiceLabel}
                                  </MenuButton>
                                  {next}
                              </div>
                              {credits}
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
