import css from "./PropertyEditor.sass?inline"
import {Lifecycle, Nullable, ObservableValue, Option, Selection, unitValue, ValueAxis} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {BoxEditing} from "@opendaw/lib-box"
import {createPropertySelectionLocator} from "@/ui/timeline/editors/notes/property/PropertySelectionLocator.ts"
import {createPropertyCapturing} from "@/ui/timeline/editors/notes/property/PropertyEventCapturing.ts"
import {createPropertyPainter} from "@/ui/timeline/editors/notes/property/PropertyPainter.ts"
import {PropertyNodeSize} from "@/ui/timeline/editors/notes/Constants.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {PropertyAccessor} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {PropertyNodeModifier} from "@/ui/timeline/editors/notes/property/PropertyNodeModifier.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {attachWheelScroll} from "@/ui/timeline/editors/WheelScroll.ts"
import {installEditorAuxBody} from "@/ui/timeline/editors/EditorBody.ts"
import {PropertyLineModifier} from "./PropertyLineModifier"
import {PropertyDrawModifier} from "@/ui/timeline/editors/notes/property/PropertyDrawModifier.ts"
import {Cursor} from "@/ui/Cursors.ts"
import {installValueInput} from "@/ui/timeline/editors/ValueInput.ts"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Dragging, Html, Keyboard, ShortcutManager} from "@opendaw/lib-dom"
import {CanvasPainter, ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {ContentEditorShortcuts} from "@/ui/shortcuts/ContentEditorShortcuts"

const className = Html.adoptStyleSheet(css, "PropertyEditor")

type Construct = {
    lifecycle: Lifecycle
    range: TimelineRange
    editing: BoxEditing
    snapping: Snapping
    selection: Selection<NoteEventBoxAdapter>
    propertyOwner: ObservableValue<PropertyAccessor>
    modifyContext: ObservableModifyContext<NoteModifier>
    reader: NoteEventOwnerReader
}

export const PropertyEditor =
    ({lifecycle, range, editing, snapping, selection, propertyOwner, modifyContext, reader}: Construct) => {
        const canvas: HTMLCanvasElement = <canvas tabIndex={-1}/>
        const padding = PropertyNodeSize
        const valueAxis: ValueAxis = {
            axisToValue: (pixel: number): unitValue =>
                1.0 - (pixel - padding) / (canvas.clientHeight - padding * 2.0),
            valueToAxis: (value: unitValue): number =>
                (1.0 - value) * (canvas.clientHeight - 2.0 * padding) + padding
        }
        const capturing = new ElementCapturing<NoteEventBoxAdapter>(canvas,
            createPropertyCapturing(valueAxis, range, propertyOwner, reader))
        const locator = createPropertySelectionLocator(reader, range, valueAxis, propertyOwner, capturing)
        const painter = lifecycle.own(new CanvasPainter(canvas, createPropertyPainter(
            {canvas, range, snapping, valueAxis, propertyOwner, modifyContext, reader})))
        lifecycle.ownAll(
            Dragging.attach(canvas, (event: PointerEvent) => {
                if (Keyboard.isControlKey(event)) {
                    return modifyContext.startModifier(PropertyDrawModifier.create({
                        editing,
                        element: canvas,
                        property: propertyOwner.getValue(),
                        selection,
                        snapping,
                        valueAxis,
                        reader
                    }))
                } else if (event.altKey) {
                    const clientRect = canvas.getBoundingClientRect()
                    return modifyContext.startModifier(PropertyLineModifier.create({
                        editing,
                        element: canvas,
                        property: propertyOwner.getValue(),
                        selection,
                        range,
                        valueAxis,
                        lineOrigin: {
                            u: range.xToUnit(event.clientX - clientRect.left),
                            v: valueAxis.axisToValue(event.clientY - clientRect.top)
                        },
                        reader
                    }))
                }
                return Option.None
            }, {permanentUpdates: true})
        )
        const selectionRectangle = (
            <SelectionRectangle lifecycle={lifecycle}
                                target={canvas}
                                selection={selection}
                                locator={locator}
                                xAxis={range.valueAxis}
                                yAxis={ValueAxis.toClamped(valueAxis, 0.0, 1.0)}/>
        )

        const element: HTMLElement = (
            <div className={className}>
                {canvas}
                {selectionRectangle}
            </div>
        )
        const shortcuts = ShortcutManager.get().createContext(canvas, "PropertyEditor")
        lifecycle.ownAll(
            shortcuts,
            shortcuts.register(ContentEditorShortcuts["select-all"].shortcut, () => selection.select(...locator.selectable())),
            shortcuts.register(ContentEditorShortcuts["deselect-all"].shortcut, () => selection.deselectAll()),
            installEditorAuxBody(canvas, range),
            Html.watchResize(element, () => range.width = element.clientWidth),
            range.subscribe(painter.requestUpdate),
            reader.subscribeChange(painter.requestUpdate),
            propertyOwner.subscribe(painter.requestUpdate),
            modifyContext.subscribeUpdate(painter.requestUpdate),
            attachWheelScroll(element, range),
            installCursor(canvas, capturing, {
                get: (_target, event) => {
                    if (event.buttons !== 0) {return null}
                    if (Keyboard.isControlKey(event)) {return Cursor.Pencil}
                    if (event.altKey) {return "crosshair"}
                    return null
                }
            }),
            Dragging.attach(canvas, (event: PointerEvent) => {
                const target: Nullable<NoteEventBoxAdapter> = capturing.captureEvent(event)
                if (target === null || selection.isEmpty()) {return Option.None}
                const clientRect = canvas.getBoundingClientRect()
                return modifyContext.startModifier(PropertyNodeModifier.create({
                    editing,
                    element: canvas,
                    selection,
                    property: propertyOwner.getValue(),
                    valueAxis,
                    pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top)
                }))
            }, {permanentUpdates: true}),
            installValueInput({
                element: canvas,
                selection,
                getter: (adapter) => {
                    const accessor = propertyOwner.getValue()
                    return accessor.stringMapping.x(accessor.readRawValue(adapter)).value
                },
                setter: text => {
                    const accessor = propertyOwner.getValue()
                    const result = accessor.stringMapping.y(text)
                    if (result.type === "explicit") {
                        editing.modify(() => selection.selected()
                            .forEach(({box}) => accessor.writeValue(box, result.value)))
                    } else if (result.type === "unitValue") {
                        editing.modify(() => {
                            const value = accessor.valueMapping.y(result.value)
                            selection.selected().forEach(({box}) => accessor.writeValue(box, value))
                        })
                    }
                }
            })
        )
        return element
    }