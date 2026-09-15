import css from "./ScriptBrowser.sass?inline"
import {Lifecycle, Procedure, RuntimeNotifier, StringComparator, TimeSpan, UUID} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Await, createElement, DomElement, Group} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {ScriptMeta, ScriptStorage} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Dialogs} from "@/ui/components/dialogs"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {ScriptDialogs} from "@/script/ScriptDialogs"

const className = Html.adoptStyleSheet(css, "ScriptBrowser")

type Construct = {
    lifecycle: Lifecycle
    select: Procedure<[UUID.Bytes, ScriptMeta]>
    onMetaChanged: Procedure<[UUID.Bytes, ScriptMeta]>
    onDeleted: Procedure<UUID.Bytes>
}

export const ScriptBrowser = ({lifecycle, select, onMetaChanged, onDeleted}: Construct) => {
    const now = new Date().getTime()
    const storage = ScriptStorage.get()
    return (
        <div className={className}>
            <header>
                <div className="name">Name</div>
                <div className="description">Description</div>
                <div className="time">Modified</div>
                <div/>
            </header>
            <Await factory={() => storage.list()}
                   loading={() => (<div className="loader"><ThreeDots/></div>)}
                   failure={({reason, retry}) => (
                       <div className="error" onclick={retry}>
                           {reason instanceof DOMException ? reason.name : String(reason)}
                       </div>
                   )}
                   success={scripts => (
                       <div className="content">
                           <div className="list" onConnect={list => lifecycle.own(installScrollbars(list))}>
                               {scripts
                                   .toSorted((a, b) => -StringComparator(a.meta.modified, b.meta.modified))
                                   .map(({uuid, meta}) => {
                                       const name: HTMLElement = <div className="name">{meta.name}</div>
                                       const description: HTMLElement = <div className="description">{meta.description}</div>
                                       const timeString = TimeSpan.millis(new Date(meta.modified).getTime() - now).toUnitString()
                                       const editIcon: DomElement = <Icon symbol={IconSymbol.Pencil} className="edit-icon"/>
                                       const deleteIcon: DomElement = <Icon symbol={IconSymbol.Delete} className="delete-icon"/>
                                       const row: HTMLElement = (
                                           <Group>
                                               <div className="labels" onclick={() => select([uuid, meta])}>
                                                   {name}
                                                   {description}
                                                   <div className="time">{timeString}</div>
                                               </div>
                                               <div className="actions">
                                                   {editIcon}
                                                   {deleteIcon}
                                               </div>
                                           </Group>
                                       )
                                       editIcon.onclick = async (event: MouseEvent) => {
                                           event.stopPropagation()
                                           const {status, value} = await Promises.tryCatch(ScriptDialogs.showMetaDialog({
                                               headline: "Edit Script", meta, buttonText: "Apply"
                                           }))
                                           if (status === "rejected") {return}
                                           Object.assign(meta, value, {modified: new Date().toISOString()})
                                           const saved = await Promises.tryCatch(storage.saveMeta(uuid, meta))
                                           if (saved.status === "rejected") {
                                               console.warn(saved.error)
                                               RuntimeNotifier.notify({message: "Could not update script.", icon: "Warning"})
                                               return
                                           }
                                           name.textContent = meta.name
                                           description.textContent = meta.description
                                           onMetaChanged([uuid, meta])
                                       }
                                       deleteIcon.onclick = async (event: MouseEvent) => {
                                           event.stopPropagation()
                                           const approved = await Dialogs.approve({
                                               headline: "Delete Script?",
                                               message: `Delete '${meta.name}'? This cannot be undone.`
                                           })
                                           if (!approved) {return}
                                           const {status, error} = await Promises.tryCatch(storage.delete(uuid))
                                           if (status === "rejected") {
                                               console.warn(error)
                                               RuntimeNotifier.notify({message: "Could not delete script.", icon: "Warning"})
                                               return
                                           }
                                           row.remove()
                                           onDeleted(uuid)
                                       }
                                       return row
                                   })}
                           </div>
                       </div>
                   )}/>
        </div>
    )
}
