import css from "./PresetItem.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {ContextMenu, MenuItem, PresetEntry} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {DragPreset} from "@/ui/AnyDragData"
import {LibraryActions} from "@/ui/browse/LibraryActions"
import {Icon} from "../components/Icon"

const className = Html.adoptStyleSheet(css, "PresetItem")

type Construct = {
    entry: PresetEntry
    actions: LibraryActions
}

export const PresetItem = ({entry, actions}: Construct): HTMLElement => {
    const item: HTMLElement = (
        <div className={className} title={entry.description}>
            <div className="marker">
                <Icon className="source"
                      symbol={entry.source === "stock" ? IconSymbol.CloudFolder : IconSymbol.UserFolder}/>
                <Icon className="swap" symbol={IconSymbol.Swap}/>
            </div>
            <span className="name">{entry.name}</span>
        </div>
    )
    item.onclick = () => actions.activatePreset(entry)
    DragAndDrop.installSource(item, () => ({
        type: "preset",
        category: entry.category,
        source: entry.source,
        uuid: entry.uuid,
        device: entry.category === "instrument" ? entry.device : null
    } satisfies DragPreset))
    if (entry.source === "user") {
        DragAndDrop.installTarget(item, {
            drag: (_event, dragData) => actions.canReplacePreset(entry, dragData),
            drop: (_event, dragData) => {
                if (actions.canReplacePreset(entry, dragData)) {
                    actions.replacePreset(entry, dragData).catch(console.warn)
                }
                item.classList.remove("accept-drop")
            },
            enter: allowDrop => item.classList.toggle("accept-drop", allowDrop),
            leave: () => item.classList.remove("accept-drop")
        })
        ContextMenu.subscribe(item, collector => collector.addItems(
            MenuItem.default({label: "Edit…"})
                .setTriggerProcedure(() => actions.editPreset(entry).catch(console.warn)),
            MenuItem.default({label: "Delete"})
                .setTriggerProcedure(() => actions.deletePreset(entry).catch(console.warn))
        ))
    }
    return item
}

export const PresetItems = (presets: ReadonlyArray<PresetEntry>, actions: LibraryActions): ReadonlyArray<HTMLElement> => {
    const user = presets.filter(entry => entry.source === "user")
    const stock = presets.filter(entry => entry.source === "stock")
    return [...user, ...stock].map(entry => PresetItem({entry, actions}))
}
