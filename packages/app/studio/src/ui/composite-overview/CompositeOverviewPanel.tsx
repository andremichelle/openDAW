import css from "./CompositeOverviewPanel.sass?inline"
import {Lifecycle, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EditorHeader} from "@/ui/code-editor/EditorHeader"
import {CompositeOverviewState} from "./CompositeOverviewState"
import {CompositeOverviewRow} from "./CompositeOverviewRow"
import {ChildReconciler} from "@/ui/devices/panel/ChildReconciler"

const className = Html.adoptStyleSheet(css, "CompositeOverviewPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    state: CompositeOverviewState
}

type RowEntry = { uuid: UUID.Bytes, element: HTMLElement, lifecycle: Terminator }

export const CompositeOverviewPanel = ({lifecycle, service, state}: Construct) => {
    const {composite, cells} = state
    const name: HTMLElement = <span className="name"/>
    const rows: HTMLElement = <div className="rows"/>
    const updateFade = () => {
        const fadeZone = 24
        const below = rows.scrollHeight - rows.clientHeight - rows.scrollTop
        rows.style.setProperty("--fade-top", `${Math.min(1, rows.scrollTop / fadeZone)}`)
        rows.style.setProperty("--fade-bottom", `${Math.max(0, Math.min(1, below / fadeZone))}`)
    }
    const rowEntries = UUID.newSet<RowEntry>(({uuid}) => uuid)
    const rebuild = lifecycle.own(deferNextFrame(() => {
        const current = composite.box.isAttached() ? cells.adapters() : []
        rowEntries.values()
            .filter(entry => !current.some(cell => UUID.equals(cell.uuid, entry.uuid)))
            .forEach(entry => rowEntries.removeByKey(entry.uuid).lifecycle.terminate())
        current.filter(cell => !rowEntries.hasKey(cell.uuid)).forEach(cell => {
            const rowLifecycle = new Terminator()
            const element: HTMLElement = <CompositeOverviewRow lifecycle={rowLifecycle} service={service} cell={cell}/>
            rowEntries.add({uuid: cell.uuid, element, lifecycle: rowLifecycle})
        })
        ChildReconciler.reconcile(rows, current.map(cell => rowEntries.get(cell.uuid).element))
        updateFade()
    }))
    const close = () => service.closeCodeEditor()
    lifecycle.ownAll(
        composite.labelField.catchupAndSubscribe(owner => name.textContent = owner.getValue()),
        cells.subscribe({onAdd: rebuild.request, onRemove: rebuild.request, onReorder: rebuild.request}),
        composite.box.subscribeDeletion(close),
        {terminate: () => rowEntries.forEach(entry => entry.lifecycle.terminate())},
        Events.subscribe(rows, "scroll", updateFade, {passive: true}),
        Html.watchResize(rows, updateFade)
    )
    if (composite.box.isAttached()) {rebuild.immediate()} else {queueMicrotask(close)}
    return (
        <div className={className}>
            <EditorHeader lifecycle={lifecycle} onClose={close} closeTooltip="Close overview">{name}</EditorHeader>
            {rows}
        </div>
    )
}
