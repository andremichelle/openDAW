import css from "./ResourceFolderItem.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Procedure} from "@opendaw/lib-std"
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
    install?: Procedure<HTMLElement>
}

export const ResourceFolderItem = ({
                                       label, count, depth, expandKey, expandedKeys, entries, install
                                   }: Construct): HTMLElement => {
    const empty = entries.length === 0
    const item: HTMLElement = <div className={Html.buildClassList(className, empty && "empty")}/>
    item.style.setProperty("--depth", String(depth))
    const header: HTMLElement = (
        <div className="folder-header">
            <span className="label">
                <div className="icon">
                    <Icon symbol={IconSymbol.Folder} className="collapsed"/>
                    <Icon symbol={IconSymbol.FolderOpen} className="expanded"/>
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
    install?.(header)
    return item
}
