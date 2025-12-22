import css from "./SampleView.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Exec, Lifecycle, Objects, UUID} from "@opendaw/lib-std"
import {SamplePlayback} from "@/service/SamplePlayback"
import {Icon} from "../components/Icon"
import {Sample} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {SampleDialogs} from "@/ui/browse/SampleDialogs"
import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {SampleSelection} from "@/ui/browse/SampleSelection"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {SampleStorage} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "Sample")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    sampleSelection: SampleSelection
    sample: Sample
    playback: SamplePlayback
    location: AssetLocation
    refresh: Exec
}

export const SampleView = ({lifecycle, service, sampleSelection, sample, playback, location, refresh}: Construct) => {
    const {name, duration, bpm} = sample
    return (
        <div className={className}
             onInit={element => lifecycle.ownAll(
                 DragAndDrop.installSource(element, () => ({type: "sample", sample})),
                 ContextMenu.subscribe(element, collector => collector.addItems(
                     MenuItem.default({label: "Create Audio Track(s)", selectable: service.hasProfile})
                         .setTriggerProcedure(() => sampleSelection.requestDevice()),
                     MenuItem.default({label: "Delete Sample(s)", selectable: location === AssetLocation.Local})
                         .setTriggerProcedure(async () => {
                             await sampleSelection.deleteSelected()
                             refresh()
                         }))
                 )
             )}
             data-selection={JSON.stringify(sample)}
             ondragstart={() => playback.eject()}
             draggable>
            <div className="meta"
                 onInit={element => lifecycle.own(
                     playback.subscribe(sample.uuid, event => {
                         element.classList.remove("buffering", "playing", "error")
                         element.classList.add(event.type)
                     })
                 )}
                 ondblclick={() => playback.toggle(sample.uuid)}>
                <span>{name}</span>
                <span className="right">{bpm.toFixed(1)}</span>
                <span className="right">{duration.toFixed(1)}</span>
            </div>
            {location === AssetLocation.Local && (
                <div className="edit">
                    <Icon symbol={IconSymbol.Pencil}
                          className="edit-icon"
                          onInit={element => element.onclick = async (event) => {
                              event.stopPropagation()
                              const {status, value: meta} =
                                  await Promises.tryCatch(SampleDialogs.showEditSampleDialog(sample))
                              if (status === "resolved") {
                                  await SampleStorage.get()
                                      .updateSampleMeta(UUID.parse(meta.uuid), Objects.exclude(meta, "uuid"))
                                  refresh()
                              }
                          }}/>
                    <Icon symbol={IconSymbol.Close}
                          className="delete-icon"
                          onInit={element => element.onclick = async (event) => {
                              event.stopPropagation()
                              await sampleSelection.deleteSamples(sample)
                              refresh()
                          }}/>
                </div>
            )}
        </div>
    )
}