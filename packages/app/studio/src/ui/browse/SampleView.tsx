import css from "./SampleView.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Arrays, Exec, Lifecycle, Objects, Option, UUID} from "@opendaw/lib-std"
import {SamplePlayback} from "@/service/SamplePlayback"
import {Sample} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {SampleDialogs} from "@/ui/browse/SampleDialogs"
import {ContextMenu, MenuItem, SampleStorage} from "@opendaw/studio-core"
import {SampleSelection} from "@/ui/browse/SampleSelection"
import {contextTargets} from "@/ui/browse/ResourceSelection"
import {ResourceMenus} from "@/ui/browse/ResourceMenus"
import {LocalTree} from "@/ui/browse/LocalTree"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {StudioService} from "@/service/StudioService"
import {WaveformIcon} from "@/ui/browse/WaveformIcon"

const className = Html.adoptStyleSheet(css, "Sample")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    sampleSelection: SampleSelection
    sample: Sample
    playback: SamplePlayback
    location: AssetLocation
    tree: Option<LocalTree<Sample>>
    refresh: Exec
}

export const SampleView = ({
                               lifecycle, service, sampleSelection, sample, playback, location, tree, refresh
                           }: Construct) => {
    const {name, duration, bpm} = sample
    const isLocal = location === AssetLocation.Local
    const isEditable = isLocal && sample.origin !== "openDAW"
    const editSample = async () => {
        const {status, value: meta} = await Promises.tryCatch(
            SampleDialogs.showEditSampleDialog(sample, service.sampleService.bpmDetector))
        if (status === "rejected") {return}
        const uuid = UUID.parse(meta.uuid)
        await SampleStorage.get().updateSampleMeta(uuid, Objects.exclude(meta, "uuid"))
        service.sampleManager.invalidate(uuid)
        refresh()
    }
    return (
        <div className={className}
             onInit={element => lifecycle.ownAll(
                 DragAndDrop.installSource(element, () => ({type: "sample", sample})),
                 ContextMenu.subscribe(element, collector => {
                     const targets = contextTargets(element, sample, () => sampleSelection.selected())
                     collector.addItems(
                         MenuItem.header({
                             label: targets.length > 1 ? `${targets.length} samples` : name,
                             icon: IconSymbol.AudioFile,
                             color: Colors.blue
                         }),
                         MenuItem.default({label: "Create Audio Track(s)", selectable: service.hasProfile})
                             .setTriggerProcedure(() => sampleSelection.requestDevice()),
                         MenuItem.default({
                             label: "Edit Name & Bpm…",
                             icon: IconSymbol.Pencil,
                             selectable: isEditable,
                             separatorBefore: true
                         }).setTriggerProcedure(() => editSample()),
                         ...tree.mapOr(local => ResourceMenus.itemActions(
                                 local, sampleSelection, targets, ({uuid}) => uuid, refresh),
                             Arrays.empty<MenuItem>())
                     )
                 })
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
                <span className="name"><WaveformIcon/>{name}</span>
                <span className="right">{bpm > 0 ? bpm.toFixed(1) : "-"}</span>
                <span className="right">{duration.toFixed(1)}</span>
            </div>
        </div>
    )
}