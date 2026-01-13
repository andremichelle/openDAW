import css from "./ProjectBrowser.sass?inline"
import {StudioService} from "@/service/StudioService"
import {
    DefaultObservableValue,
    Lifecycle,
    Procedure,
    RuntimeNotifier,
    RuntimeSignal,
    StringComparator,
    TimeSpan,
    UUID
} from "@moises-ai/lib-std"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Dialogs} from "@/ui/components/dialogs"
import {Await, createElement, DomElement, Frag, Group} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {ContextMenu, MenuItem, ProjectMeta, ProjectSignals, ProjectStorage} from "@moises-ai/studio-core"
import {SearchInput} from "@/ui/components/SearchInput"
import {ThreeDots} from "@/ui/spinner/ThreeDots"

const className = Html.adoptStyleSheet(css, "ProjectBrowser")

type Construct = {
    service: StudioService
    lifecycle: Lifecycle
    select: Procedure<[UUID.Bytes, ProjectMeta]>
}

export const ProjectBrowser = ({service, lifecycle, select}: Construct) => {
    const now = new Date().getTime()
    const filter = new DefaultObservableValue("")
    return (
        <div className={className}>
            <div className="filter">
                <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
            </div>
            <header>
                <div className="name">Name</div>
                <div className="time">Modified</div>
                <div/>
            </header>
            <Await factory={() => ProjectStorage.listProjects()}
                   loading={() => (<div className="loader"><ThreeDots/></div>)}
                   failure={({reason, retry}) => (
                       <div className="error" onclick={retry}>
                           {reason instanceof DOMException ? reason.name : String(reason)}
                       </div>
                   )}
                   repeat={exec => lifecycle.own(RuntimeSignal
                       .subscribe(signal => signal === ProjectSignals.StorageUpdated && exec()))}
                   success={projects => (
                       <Frag>
                           <div className="content">
                               <div className="list">
                                   {projects
                                       .toSorted((a, b) => -StringComparator(a.meta.modified, b.meta.modified))
                                       .map(({uuid, meta}) => {
                                           const icon: DomElement = <Icon symbol={IconSymbol.Delete}
                                                                          className="delete-icon"/>
                                           const timeString = TimeSpan.millis(new Date(meta.modified).getTime() - now).toUnitString()
                                           const row: HTMLElement = (
                                               <Group onInit={element => filter.catchupAndSubscribe(owner => {
                                                   element.classList.toggle("hidden", !meta.name
                                                       .toLowerCase()
                                                       .includes(owner.getValue().toLowerCase()))
                                               })}>
                                                   <div className="labels"
                                                        onclick={() => select([uuid, meta])}
                                                        onInit={element => lifecycle.own(ContextMenu.subscribe(element,
                                                            collector => collector.addItems(MenuItem.default({
                                                                label: "Show UUID"
                                                            }).setTriggerProcedure(() => RuntimeNotifier.info({
                                                                headline: meta.name,
                                                                message: UUID.toString(uuid)
                                                            })))))}>
                                                       <div className="name">{meta.name}</div>
                                                       <div className="time">{timeString}</div>
                                                   </div>
                                                   {icon}
                                               </Group>
                                           )
                                           icon.onclick = (event) => {
                                               event.stopPropagation()
                                               Dialogs.approve({
                                                   headline: "Delete Project?",
                                                   message: "Are you sure? This cannot be undone."
                                               }).then(approved => {
                                                   if (approved) {
                                                       service.deleteProject(uuid, meta).then(() => row.remove())
                                                   }
                                               })
                                           }
                                           return row
                                       })}
                               </div>
                           </div>
                       </Frag>
                   )}/>
        </div>
    )
}