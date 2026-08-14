import css from "./SoundfontView.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Arrays, Exec, isDefined, Lifecycle, Objects, Option, UUID} from "@opendaw/lib-std"
import {Soundfont} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu, MenuItem, SoundfontStorage} from "@opendaw/studio-core"
import {Html} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {SoundfontSelection} from "@/ui/browse/SoundfontSelection"
import {contextTargets} from "@/ui/browse/ResourceSelection"
import {ResourceMenus} from "@/ui/browse/ResourceMenus"
import {LocalTree} from "@/ui/browse/LocalTree"
import {FileIcon} from "@/ui/browse/FileIcon"
import {SoundfontDialogs} from "@/ui/browse/SoundfontDialogs"
import {StudioService} from "@/service/StudioService"
import {Promises} from "@opendaw/lib-runtime"

const className = Html.adoptStyleSheet(css, "Soundfont")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    soundfontSelection: SoundfontSelection
    soundfont: Soundfont
    tree: Option<LocalTree<Soundfont>>
    refresh: Exec
}

const formatBytes = (bytes: number, decimals = 1): string => {
    if (bytes === 0) {return "0 B"}
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    const value = bytes / Math.pow(k, i)
    return `${value.toFixed(decimals)} ${sizes[i]}`
}

export const SoundfontView = ({lifecycle, service, soundfontSelection, soundfont, tree, refresh}: Construct) => {
    const {name, size} = soundfont
    const isEditable = soundfont.origin !== "openDAW"
    const editSoundfont = async () => {
        const {status, value: edited} = await Promises.tryCatch(SoundfontDialogs.showEditSoundfontDialog(soundfont))
        if (status === "rejected") {return}
        const uuid = UUID.parse(edited.uuid)
        await SoundfontStorage.get().updateMeta(uuid, Objects.exclude(edited, "uuid"))
        service.soundfontManager.invalidate(uuid)
        refresh()
    }
    const element: HTMLElement = (
        <div className={className}
             data-selection={JSON.stringify(soundfont)}
             draggable>
            <div className="meta">
                <span className="name"><FileIcon/>{name}</span>
                <span style={{textAlign: "right"}}>{isDefined(size) ? formatBytes(size) : "N/A"}</span>
            </div>
        </div>
    )
    lifecycle.ownAll(
        DragAndDrop.installSource(element, () => ({type: "soundfont", soundfont})),
        ContextMenu.subscribe(element, collector => {
            const targets = contextTargets(element, soundfont, () => soundfontSelection.selected())
            collector.addItems(
                MenuItem.header({
                    label: targets.length > 1 ? `${targets.length} soundfonts` : name,
                    icon: IconSymbol.AudioFile,
                    color: Colors.blue
                }),
                MenuItem.default({label: "Create Soundfont Device"})
                    .setTriggerProcedure(() => soundfontSelection.requestDevice(targets)),
                MenuItem.default({
                    label: "Edit Meta…",
                    icon: IconSymbol.Pencil,
                    selectable: isEditable,
                    separatorBefore: true
                }).setTriggerProcedure(() => editSoundfont()),
                ...tree.mapOr(local => ResourceMenus.itemActions(
                        local, soundfontSelection, targets, ({uuid}) => uuid, refresh),
                    Arrays.empty<MenuItem>()))
        })
    )
    return element
}