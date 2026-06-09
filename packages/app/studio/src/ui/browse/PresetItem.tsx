import css from "./PresetItem.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {isDefined, Lifecycle, Nullable, StringComparator} from "@opendaw/lib-std"
import {MenuItem, PresetEntry} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {DragPreset} from "@/ui/AnyDragData"
import {PresetService} from "@/ui/browse/PresetService"
import {Icon} from "../components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "PresetItem")

type Construct = {
    entry: PresetEntry
    presetService: PresetService
    lifecycle: Lifecycle
}

export const PresetItem = ({entry, presetService, lifecycle}: Construct): HTMLElement => {
    const userMenuRoot: Nullable<MenuItem> = entry.source === "user"
        ? MenuItem.root().setRuntimeChildrenProcedure(parent => {
            const canUpload = new URLSearchParams(location.search).has("access-key")
            parent.addMenuItem(
                MenuItem.default({label: "Edit…"})
                    .setTriggerProcedure(() => presetService.editPreset(entry).catch(console.warn)),
                MenuItem.default({label: "Duplicate"})
                    .setTriggerProcedure(() => presetService.duplicatePreset(entry).catch(console.warn)),
                ...(canUpload ? [MenuItem.default({label: "Upload"})
                    .setTriggerProcedure(() => presetService.uploadPreset(entry).catch(console.warn))] : []),
                MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => presetService.deletePreset(entry).catch(console.warn)),
                MenuItem.default({label: "Save to Disk…", separatorBefore: true})
                    .setTriggerProcedure(() => presetService.savePresetToDisk(entry).catch(console.warn))
            )
        })
        : null
    const item: HTMLElement = (
        <div className={className}>
            <div className="marker">
                <Icon className="source"
                      symbol={entry.source === "stock" ? IconSymbol.CloudFolder : IconSymbol.UserFolder}/>
                <Icon className="swap" symbol={IconSymbol.Swap}/>
            </div>
            <div className="title">
                <span className="name">{entry.name}</span>
                {entry.hasTimeline === true && (
                    <span className="timeline-badge" title="Including timeline data">
                        <Icon symbol={IconSymbol.Timeline}/>
                    </span>
                )}
                {isDefined(userMenuRoot) && (
                    <span className="menu" onclick={(event: MouseEvent) => event.stopPropagation()}>
                        <MenuButton root={userMenuRoot} appearance={{tooltip: "Preset actions"}}>
                            <Icon symbol={IconSymbol.Menu}/>
                        </MenuButton>
                    </span>
                )}
            </div>
        </div>
    )
    if (entry.description.length > 0) {
        lifecycle.own(TextTooltip.default(item, () => entry.description))
    }
    item.onclick = () => presetService.activatePreset(entry)
    DragAndDrop.installSource(item, () => ({
        type: "preset",
        category: entry.category,
        source: entry.source,
        uuid: entry.uuid,
        device: entry.category === "instrument" ? entry.device : null
    } satisfies DragPreset))
    if (entry.source === "user") {
        DragAndDrop.installTarget(item, {
            drag: (_event, dragData) => presetService.canReplacePreset(entry, dragData),
            drop: (_event, dragData) => {
                if (presetService.canReplacePreset(entry, dragData)) {
                    presetService.replacePreset(entry, dragData).catch(console.warn)
                }
                item.classList.remove("accept-drop")
            },
            enter: allowDrop => item.classList.toggle("accept-drop", allowDrop),
            leave: () => item.classList.remove("accept-drop")
        })
    }
    return item
}

export const PresetItems = (presets: ReadonlyArray<PresetEntry>,
                            presetService: PresetService,
                            lifecycle: Lifecycle): ReadonlyArray<HTMLElement> => {
    const byName = (left: PresetEntry, right: PresetEntry) =>
        StringComparator(left.name.toLowerCase(), right.name.toLowerCase())
    const user = presets.filter(entry => entry.source === "user").toSorted(byName)
    const stock = presets.filter(entry => entry.source === "stock").toSorted(byName)
    return [...user, ...stock].map(entry => PresetItem({entry, presetService, lifecycle}))
}
