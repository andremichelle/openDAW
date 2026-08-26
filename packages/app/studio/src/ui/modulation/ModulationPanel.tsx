import css from "./ModulationPanel.sass?inline"
import {isAbsent, isInstanceOf, Lifecycle, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {ModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {ClipboardManager, MenuItem, ModulatorsClipboard} from "@opendaw/studio-core"
import {ModulatorClipboardContext} from "@/ui/modulation/ModulatorClipboardContext.ts"
import {createModulatorEditor} from "@/ui/modulation/ModulatorEditorFactory.tsx"
import {installScrollbars} from "@/ui/components/Scrollbars.tsx"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ModulatorReveal} from "@/ui/modulation/ModulatorReveal.ts"

const className = Html.adoptStyleSheet(css, "ModulationPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ModulationPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const contents = lifecycle.own(new Terminator())
    const scroller: HTMLElement = (
        <div className="scroller" onConnect={host => {
            revealRequested()
            // Dragging a modulator past the edge scrolls the list, so a target below the fold is reachable.
            lifecycle.own(installAutoScroll(host, (_deltaX, deltaY) => host.scrollTop += deltaY,
                {padding: [24, 0, 24, 0]}))
            return lifecycle.own(installScrollbars(host))
        }}>
            <h5 className="head modulators">
                <span>Modulators</span>
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                    parent.addMenuItem(...Modulators.Kinds.map(kind => MenuItem.default({label: kind.label})
                        .setTriggerProcedure(() => editing.modify(() => kind.create(project))))))}
                            appearance={{}}>
                    <Icon symbol={IconSymbol.Add}/>
                </MenuButton>
            </h5>
            <h5 className="head targets"><span>Targets</span></h5>
        </div>
    )
    const {modulatorSelection} = project
    const element: HTMLElement = (
        <div className={className} tabIndex={0} onInit={element => lifecycle.ownAll(
            // ONE clipboard for the whole list (a modulator has no per-editor host the way a device has a
            // chain), so copy and paste keep working wherever the focus sits inside the panel.
            ClipboardManager.install(element,
                ModulatorsClipboard.createHandler(ModulatorClipboardContext.of(project))),
            // A click on anything but an editor drops the selection, the way the device panel does it.
            Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                const target = event.target
                if (target instanceof Element && isAbsent(target.closest("[data-modulator]"))) {
                    modulatorSelection.deselectAll()
                }
            }),
            Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
                if (!Keyboard.isDelete(event) || modulatorSelection.isEmpty()) {return}
                if (Events.isTextInput(document.activeElement)) {return}
                event.preventDefault()
                const doomed = modulatorSelection.selected().map(adapter => adapter.box)
                modulatorSelection.deselectAll()
                editing.modify(() => Modulators.deleteAll(project, doomed))
            }))}>{scroller}</div>
    )
    const editors = UUID.newSet<{uuid: UUID.Bytes, element: HTMLElement}>(entry => entry.uuid)
    /// The editor's own element is `display: contents`, so the scroll must target the row that has a box.
    const revealRequested = () => ModulatorReveal.requested.ifSome(uuid => editors.opt(uuid)
        .ifSome(({element}) => {
            const row = element.firstElementChild
            if (!isInstanceOf(row, HTMLElement) || !row.isConnected) {return}
            row.scrollIntoView({block: "nearest"})
            ModulatorReveal.requested.clear()
        }))
    const render = () => {
        // A re-render throws away the focused header, and focus would fall back to the document body,
        // out of reach of the panel's own Delete shortcut. Hand it to the panel instead.
        const hadFocus = element.contains(document.activeElement)
        contents.terminate()
        editors.clear()
        while (scroller.childElementCount > 2) {scroller.lastElementChild?.remove()}
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            scroller.append(<div className="placeholder">
                Add a modulator, or right-click any device control and choose Modulate
            </div>)
            return
        }
        adapters.forEach((adapter: ModulatorBoxAdapter) => {
            const editor = createModulatorEditor(contents, service, adapter) as HTMLElement
            editors.add({uuid: adapter.uuid, element: editor})
            scroller.append(editor)
        })
        if (hadFocus) {element.focus()}
        revealRequested()
    }
    lifecycle.ownAll(
        rootBoxAdapter.modulators.catchupAndSubscribe({
            onAdd: () => render(),
            onRemove: () => render(),
            onReorder: () => render()
        }),
        ModulatorReveal.requested.subscribe(() => revealRequested()))
    render()
    return element
}
