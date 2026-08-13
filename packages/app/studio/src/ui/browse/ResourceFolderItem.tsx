import css from "./ResourceFolderItem.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "ResourceFolderItem")

type Construct = {
    label: string
    count: number
    depth: number
    expandKey: string
    expandedKeys: Set<string>
    entries: ReadonlyArray<HTMLElement>
}

export const ResourceFolderItem = ({label, count, depth, expandKey, expandedKeys, entries}: Construct): HTMLElement => {
    const empty = entries.length === 0
    const item: HTMLElement = <div className={Html.buildClassList(className, empty && "empty")}/>
    item.style.setProperty("--depth", String(depth))
    // Stays a subgrid so the trailing cells land under Bpm and Sec. The label is a nested flex, which is what
    // keeps triangle, icon, name and count together in the first column.
    const header: HTMLElement = (
        <div className="folder-header">
            <span className="label">
                <span className="marker">
                    <Icon symbol={IconSymbol.ArrowRight} className="collapsed"/>
                    <Icon symbol={IconSymbol.ArrowDown} className="expanded"/>
                </span>
                <div className="icon">
                    <Icon symbol={IconSymbol.Folder}/>
                </div>
                <span className="name">{label}</span>
                <span className="brief">{count === 0 ? "" : `(${count})`}</span>
            </span>
            <span className="right">-</span>
            <span className="right">-</span>
        </div>
    )
    const list: HTMLElement = <div className="entry-list hidden"/>
    list.append(...entries)
    if (!empty && expandedKeys.has(expandKey)) {
        list.classList.remove("hidden")
        item.classList.add("expanded")
    }
    if (!empty) {
        header.onclick = () => {
            const open = !list.classList.toggle("hidden")
            item.classList.toggle("expanded", open)
            if (open) {expandedKeys.add(expandKey)} else {expandedKeys.delete(expandKey)}
        }
    }
    item.append(header, list)
    return item
}
