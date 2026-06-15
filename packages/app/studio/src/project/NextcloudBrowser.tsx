import css from "./NextcloudBrowser.sass?inline"
import {
    DefaultObservableValue,
    Exec,
    Lifecycle,
    Procedure,
    RuntimeNotifier,
    StringComparator,
    TimeSpan,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialogs} from "@/ui/components/dialogs"
import {Await, createElement, DomElement, Frag, Group} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {CloudHandler, SharedFolderSync} from "@opendaw/studio-core"
import {SearchInput} from "@/ui/components/SearchInput"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "NextcloudBrowser")

type Construct = {
    lifecycle: Lifecycle
    handler: CloudHandler
    username: string
    select: Procedure<SharedFolderSync.Listing>
    // Called after deletion (which tears this dialog down) so the host can recreate the browser.
    reopen: Exec
}

const plural = (count: number, noun: string): string => count === 1 ? noun : `${noun}s`

export const NextcloudBrowser = ({lifecycle, handler, username, select, reopen}: Construct) => {
    const now = new Date().getTime()
    const filter = new DefaultObservableValue("")
    return (
        <div className={className}>
            <div className="filter">
                <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
            </div>
            <div className="user"><Icon symbol={IconSymbol.UserFolder} className="icon"/>{username}</div>
            <Await factory={() => SharedFolderSync.readCatalog(handler)}
                   loading={() => (<div className="loader"><ThreeDots/></div>)}
                   failure={({reason, retry}) => (
                       <div className="error" onclick={retry}>
                           {reason instanceof DOMException ? reason.name : String(reason)}
                       </div>
                   )}
                   success={catalog => {
                       const listings: ReadonlyArray<SharedFolderSync.Listing> = Object.entries(catalog.projects)
                           .map(([uuid, entry]) => ({uuid: UUID.parse(uuid), entry}))
                       const {samples, soundfonts} = SharedFolderSync.countAssets(catalog)
                       const info = `${listings.length} ${plural(listings.length, "project")} · `
                           + `${samples} ${plural(samples, "sample")} · `
                           + `${soundfonts} ${plural(soundfonts, "soundfont")}`
                       return (
                           <Frag>
                               <div className="info">{info}</div>
                               <header>
                                   <div className="name">Name</div>
                                   <div className="time">Modified</div>
                                   <div/>
                               </header>
                               <div className="content">
                                   <div className="list"
                                        onConnect={list => lifecycle.own(installScrollbars(list))}>
                                       {listings
                                           .toSorted((left, right) =>
                                               -StringComparator(left.entry.meta.modified, right.entry.meta.modified))
                                           .map(listing => {
                                               const {uuid, entry} = listing
                                               const icon: DomElement = <Icon symbol={IconSymbol.Delete}
                                                                              className="delete-icon"/>
                                               const timeString = TimeSpan
                                                   .millis(new Date(entry.meta.modified).getTime() - now).toUnitString()
                                               const row: HTMLElement = (
                                                   <Group onInit={element => filter.catchupAndSubscribe(owner => {
                                                       element.classList.toggle("hidden", !entry.meta.name
                                                           .toLowerCase()
                                                           .includes(owner.getValue().toLowerCase()))
                                                   })}>
                                                       <div className="labels" onclick={() => select(listing)}>
                                                           <div className="name">{entry.meta.name}</div>
                                                           <div className="time">{timeString}</div>
                                                       </div>
                                                       {icon}
                                                   </Group>
                                               )
                                               icon.onclick = (event) => {
                                                   event.stopPropagation()
                                                   Dialogs.approve({
                                                       headline: "Delete Project?",
                                                       message: "Deletes it from Nextcloud, including assets no other"
                                                           + " project uses. This cannot be undone."
                                                   }).then(async approved => {
                                                       if (!approved) {return}
                                                       const progressValue = new DefaultObservableValue<unitValue>(0.0)
                                                       const notifier = RuntimeNotifier.progress({
                                                           headline: "Nextcloud",
                                                           message: `Deleting "${entry.meta.name}"...`,
                                                           progress: progressValue
                                                       })
                                                       const {status, error} = await Promises
                                                           .tryCatch(SharedFolderSync.deleteProject(handler, uuid,
                                                               value => progressValue.setValue(value)))
                                                       notifier.terminate()
                                                       if (status === "rejected") {
                                                           console.warn(error)
                                                           RuntimeNotifier.notify({message: "Delete failed.", icon: "Warning"})
                                                       }
                                                       reopen()
                                                   })
                                               }
                                               return row
                                           })}
                                   </div>
                               </div>
                           </Frag>
                       )
                   }}/>
        </div>
    )
}
