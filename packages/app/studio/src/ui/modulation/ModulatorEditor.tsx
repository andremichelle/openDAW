import css from "./ModulatorEditor.sass?inline"
import {Errors, Lifecycle, Nullable, ObservableValue, panic, UUID} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem, ModulatorsClipboard} from "@opendaw/studio-core"
import {ModulatorReveal} from "@/ui/modulation/ModulatorReveal.ts"
import {DebugMenus} from "@/ui/menu/debug.ts"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {TargetList} from "@/ui/modulation/TargetList.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"
import {GhostCount} from "@/ui/devices/GhostCount"
import {ModulatorClipboardContext} from "@/ui/modulation/ModulatorClipboardContext.ts"

const className = Html.adoptStyleSheet(css, "ModulatorEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: ModulatorBoxAdapter
}

export const ModulatorEditor = ({lifecycle, service, modulator}: Construct, controls: JsxValue) => {
    const {project} = service
    const {editing, modulatorSelection} = project
    const labelField = modulator.box.label
    const title: HTMLElement = (
        <h1 onInit={element => lifecycle.ownAll(
            labelField.catchupAndSubscribe(owner => element.textContent = owner.getValue()),
            Events.subscribeDblDwn(element, async event => {
                const {status, error, value} = await Promises.tryCatch(
                    Surface.get(element).requestFloatingTextInput(event, labelField.getValue()))
                if (status === "rejected") {
                    if (!Errors.isAbort(error)) {return panic(error)}
                } else {
                    editing.modify(() => labelField.setValue(value))
                }
            }))}/>
    )
    // Whatever the menu acts on: the whole selection when this modulator is part of it, else this one alone.
    const acted = () => {
        const selected = modulatorSelection.selected()
        return selected.includes(modulator) ? selected.map(adapter => adapter.box) : [modulator.box]
    }
    const mark = (element: HTMLElement, insert: Nullable<"before" | "after">) => {
        element.classList.toggle("insert-before", insert === "before")
        element.classList.toggle("insert-after", insert === "after")
    }
    return (
        <div className={className}
             onInit={element => lifecycle.own(modulator.box.enabled
                 .catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                     element.classList.toggle("disabled", !owner.getValue())))}>
            <div className="modulator" data-modulator={true}
                 onInit={row => lifecycle.own(DragAndDrop.installTarget(row, {
                     drag: (_event: DragEvent, data: AnyDragData): boolean => {
                         if (data.type !== "modulator"
                             || data.uuids.includes(UUID.toString(modulator.uuid))) {return false}
                         mark(row, data.index < modulator.indexField.getValue() ? "after" : "before")
                         return true
                     },
                     drop: (event: DragEvent, data: AnyDragData) => {
                         mark(row, null)
                         if (data.type !== "modulator") {return}
                         event.preventDefault()
                         const dragged = project.rootBoxAdapter.modulators.adapters()
                             .filter(adapter => data.uuids.includes(UUID.toString(adapter.uuid)))
                             .map(adapter => adapter.box)
                         if (dragged.length === 0) {return}
                         editing.modify(() => Modulators.move(project, dragged, modulator.box))
                     },
                     enter: () => {},
                     leave: () => mark(row, null)
                 }))}>
                <header tabIndex={0} onInit={element => {
                    const updateSelected = () =>
                        element.classList.toggle("selected", modulatorSelection.isSelected(modulator))
                    let pendingCollapseSelection = false
                    let dragStartedOnHeader = false
                    lifecycle.ownAll(
                        modulatorSelection.catchupAndSubscribe({
                            onSelected: updateSelected,
                            onDeselected: updateSelected
                        }),
                        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                            dragStartedOnHeader = false
                            if (event.shiftKey || event.metaKey || event.ctrlKey) {
                                if (modulatorSelection.isSelected(modulator)) {
                                    modulatorSelection.deselect(modulator)
                                } else {
                                    modulatorSelection.select(modulator)
                                }
                                pendingCollapseSelection = false
                            } else if (modulatorSelection.isSelected(modulator)) {
                                pendingCollapseSelection = true
                            } else {
                                modulatorSelection.deselectAll()
                                modulatorSelection.select(modulator)
                                pendingCollapseSelection = false
                            }
                        }),
                        Events.subscribe(element, "pointerup", () => {
                            if (pendingCollapseSelection && !dragStartedOnHeader) {
                                modulatorSelection.deselectAll()
                                modulatorSelection.select(modulator)
                            }
                            pendingCollapseSelection = false
                            dragStartedOnHeader = false
                        }),
                        DragAndDrop.installSource(element, () => {
                            dragStartedOnHeader = true
                            return {
                                type: "modulator",
                                uuids: ModulatorsClipboard.dragUuids(modulatorSelection, modulator),
                                index: modulator.indexField.getValue()
                            } satisfies AnyDragData
                        }, element, () => GhostCount({
                            count: ModulatorsClipboard.dragUuids(modulatorSelection, modulator).length,
                            color: Colors.blue
                        }))
                    )
                }}>
                    <Icon symbol={IconSymbol.Shutdown} className="toggle" onInit={element =>
                        lifecycle.ownAll(
                            Events.subscribe(element, "pointerdown", event => event.stopPropagation()),
                            Events.subscribe(element, "click", () =>
                                editing.modify(() => modulator.box.enabled.toggle())))}/>
                    {title}
                    <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        MenuItem.default({label: "Replace with"}).setRuntimeChildrenProcedure(sub =>
                            sub.addMenuItem(...Modulators.Kinds.map(kind => MenuItem.default({
                                label: kind.label,
                                checked: kind.boxName === modulator.box.name,
                                selectable: kind.boxName !== modulator.box.name
                            }).setTriggerProcedure(() => editing.modify(() =>
                                Modulators.replace(project, modulator.box, kind)))))),
                        MenuItem.default({label: labelFor("Duplicate", acted().length)})
                            .setTriggerProcedure(() => {
                                if (!modulatorSelection.isSelected(modulator)) {
                                    modulatorSelection.deselectAll()
                                    modulatorSelection.select(modulator)
                                }
                                ModulatorsClipboard.duplicate(ModulatorClipboardContext.of(project))
                                // The paste leaves the copies selected; scroll to the first of them.
                                const copies = modulatorSelection.selected()
                                    .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
                                if (copies.length > 0) {ModulatorReveal.request(copies[0].uuid)}
                            }),
                        MenuItem.default({label: labelFor("Delete", acted().length), separatorBefore: true})
                            .setTriggerProcedure(() => {
                                const doomed = acted()
                                modulatorSelection.deselectAll()
                                editing.modify(() => Modulators.deleteAll(project, doomed))
                            }),
                        DebugMenus.debugBox(modulator.box)))}
                                appearance={{color: Colors.cream}}>
                        <Icon symbol={IconSymbol.Menu}/>
                    </MenuButton>
                </header>
                <div className="body">{controls}</div>
            </div>
            <TargetList lifecycle={lifecycle} service={service} modulator={modulator}/>
        </div>
    )
}

const labelFor = (verb: string, count: number): string => count === 1 ? verb : `${verb} ${count} Modulators`
