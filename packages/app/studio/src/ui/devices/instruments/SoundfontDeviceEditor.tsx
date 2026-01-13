import css from "./SoundfontDeviceEditor.sass?inline"
import {int, Lifecycle, Option, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceHost, InstrumentFactories, Soundfont, SoundfontDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {MenuItem} from "@moises-ai/studio-core"
import type {Preset} from "soundfont2"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"
import {FlexSpacer} from "@/ui/components/FlexSpacer"
import {SoundfontFileBox} from "@moises-ai/studio-boxes"
import {IconSymbol} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "editor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SoundfontDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const SoundfontDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {} = adapter.namedParameter
    const {project} = service
    const {boxGraph, editing, liveStreamReceiver} = project
    const labelSoundfontName: HTMLElement = <span/>
    const labelPresetName: HTMLElement = <span data-index="1"/>
    const loaderLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        adapter.loader.catchupAndSubscribe(optLoader => {
            loaderLifecycle.terminate()
            optLoader.ifSome(loader => {
                if (loader.soundfont.isEmpty()) {
                    labelSoundfontName.textContent = "Loading..."
                }
                loaderLifecycle.own(loader.subscribe(state => {
                    if (state.type === "progress") {
                        labelSoundfontName.textContent = `Loading... ${Math.round(state.progress * 100)}%`
                    }
                }))
            })
        }),
        adapter.soundfont.catchupAndSubscribe(optSoundfont => labelSoundfontName.textContent = optSoundfont
            .mapOr(soundfont => soundfont.metaData.name, "No Soundfont")),
        adapter.preset.catchupAndSubscribe(optPreset => optPreset.match({
            none: () => {
                labelPresetName.textContent = "No Preset"
                labelPresetName.dataset["index"] = ""
            },
            some: preset => {
                labelPresetName.textContent = preset.header.name
                labelPresetName.dataset["index"] = `#${adapter.presetIndex + 1}`
            }
        }))
    )
    const applySoundfont = (soundfont: Soundfont): void => {
        const uuid = UUID.parse(soundfont.uuid)
        editing.modify(() => {
            const targetVertex = adapter.box.file.targetVertex.unwrapOrNull()
            const fileBox = boxGraph.findBox<SoundfontFileBox>(uuid).unwrapOrElse(() =>
                SoundfontFileBox.create(boxGraph, uuid, box => box.fileName.setValue(soundfont.name)))
            adapter.box.presetIndex.setValue(0)
            adapter.box.file.refer(fileBox)
            if (targetVertex?.box.isValid() === false) {
                targetVertex.box.delete()
            }
        })
    }
    const populateMenu = (scope: Option<ReadonlyArray<Soundfont>>): ReadonlyArray<MenuItem> => {
        return scope.match({
            none: () => [MenuItem.default({
                label: "Could not load library",
                selectable: false
            })],
            some: list => list.map((soundfont: Soundfont) =>
                MenuItem.default({
                    label: soundfont.name,
                    checked: adapter.box.file.targetAddress.match({
                        none: () => false,
                        some: ({uuid}) => UUID.toString(uuid) === soundfont.uuid
                    })
                }).setTriggerProcedure(() => applySoundfont(soundfont)))
        })
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <FlexSpacer pixels={2}/>
                              <header>
                                  <Icon symbol={IconSymbol.Book}/>
                                  <h1>Soundfont</h1>
                              </header>
                              <div className="label">
                                  <MenuButton
                                      root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
                                          parent.addMenuItem(
                                              MenuItem.default({
                                                  label: "Stock",
                                                  icon: IconSymbol.CloudFolder,
                                                  selectable: service.soundfontService
                                                      .remote.mapOr(list => list.length > 0, false)
                                              }).setRuntimeChildrenProcedure(parent => parent
                                                  .addMenuItem(...populateMenu(service.soundfontService.remote))),
                                              MenuItem.default({
                                                  label: "Local",
                                                  icon: IconSymbol.UserFolder,
                                                  selectable: service.soundfontService
                                                      .local.mapOr(list => list.length > 0, false)
                                              }).setRuntimeChildrenProcedure(parent => parent
                                                  .addMenuItem(...populateMenu(service.soundfontService.local))),
                                              MenuItem.default({label: "Import Soundfont...", separatorBefore: true})
                                                  .setTriggerProcedure(async () => {
                                                      const soundfonts = await service.soundfontService.browse(false)
                                                      if (soundfonts.length > 0) {
                                                          applySoundfont(soundfonts[0])
                                                      }
                                                  })
                                          )
                                      })}>
                                      {labelSoundfontName}
                                  </MenuButton>
                              </div>
                              <FlexSpacer pixels={4}/>
                              <header>
                                  <Icon symbol={IconSymbol.Piano}/>
                                  <h1 onInit={element => lifecycle.own(adapter.soundfont
                                      .catchupAndSubscribe(optSoundfont =>
                                          element.dataset["count"] = optSoundfont.match({
                                              none: () => "",
                                              some: soundfont => `(${soundfont.presets.length})`
                                          })))}>Preset</h1>
                              </header>
                              <div className="label">
                                  <MenuButton
                                      root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                          ...adapter.soundfont.mapOr(sf => sf.presets
                                                  .map((preset: Preset, index: int) => MenuItem.default({
                                                      label: `#${index + 1} ${preset.header.name}`,
                                                      checked: adapter.presetIndex === index
                                                  }).setTriggerProcedure(() =>
                                                      editing.modify(() => adapter.box.presetIndex.setValue(index)))),
                                              [MenuItem.default({label: "No soundfonts available"})])
                                      ))}>
                                      {labelPresetName}
                                  </MenuButton>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Soundfont.defaultIcon}/>
    )
}