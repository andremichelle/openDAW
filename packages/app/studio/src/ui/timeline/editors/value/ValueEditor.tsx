import css from "./ValueEditor.sass?inline"
import {
    EmptyExec,
    Func,
    Lifecycle,
    Nullable,
    Option,
    Selection,
    unitValue,
    ValueAxis,
    ValueMapping
} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {ValueEventBoxAdapter} from "@opendaw/studio-adapters"
import {ValueEventBox} from "@opendaw/studio-boxes"
import {RangePadding} from "@/ui/timeline/editors/value/Constants.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {ValueModifier} from "@/ui/timeline/editors/value/ValueModifier.ts"
import {createValuePainter} from "@/ui/timeline/editors/value/ValuePainter.ts"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {createValueEventCapturing, ValueCaptureTarget} from "@/ui/timeline/editors/value/ValueEventCapturing.ts"
import {createValueSelectionLocator} from "@/ui/timeline/editors/value/ValueSelectionLocator.ts"
import {ValuePaintModifier} from "@/ui/timeline/editors/value/ValuePaintModifier.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {SnapValueThresholdInPixels, ValueMoveModifier} from "@/ui/timeline/editors/value/ValueMoveModifier.ts"
import {ValueSlopeModifier} from "@/ui/timeline/editors/value/ValueSlopeModifier.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {Cursor} from "@/ui/Cursors.ts"
import {installValueContextMenu} from "@/ui/timeline/editors/value/ValueContextMenu.ts"
import {createElement} from "@opendaw/lib-jsx"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {installValueInput} from "@/ui/timeline/editors/ValueInput.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {installEditorBody} from "../EditorBody"
import {ValueContentDurationModifier} from "./ValueContentDurationModifier"
import {Dragging, Events, Html, ShortcutManager} from "@opendaw/lib-dom"
import {ValueTooltip} from "./ValueTooltip"
import {ValueEventEditing} from "./ValueEventEditing"
import {CanvasPainter, ClipboardManager, TimelineRange, ValuesClipboard} from "@opendaw/studio-core"
import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"
import {ContentEditorShortcuts} from "@/ui/shortcuts/ContentEditorShortcuts"

const className = Html.adoptStyleSheet(css, "ValueEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    range: TimelineRange
    snapping: Snapping
    eventMapping: ValueMapping<number>
    reader: ValueEventOwnerReader
    context: ValueContext
}

export const ValueEditor = ({lifecycle, service, range, snapping, eventMapping, reader, context}: Construct) => {
    const {project} = service
    const {editing, engine, boxGraph, boxAdapters} = project
    const eventsField = reader.content.box.events
    const selection: Selection<ValueEventBoxAdapter> = lifecycle.own(project.selection
        .createFilteredSelection(box => box instanceof ValueEventBox
            && box.events.targetVertex.contains(eventsField), {
            fx: (adapter: ValueEventBoxAdapter) => adapter.box,
            fy: vertex => project.boxAdapters.adapterFor(vertex.box, ValueEventBoxAdapter)
        }))
    lifecycle.own(selection.catchupAndSubscribe({
        onSelected: (adapter: ValueEventBoxAdapter) => adapter.onSelected(),
        onDeselected: (adapter: ValueEventBoxAdapter) => adapter.onDeselected()
    }))
    const canvas: HTMLCanvasElement = <canvas tabIndex={-1}/>
    const valueAxis: ValueAxis = {
        axisToValue: (pixel: number): unitValue =>
            eventMapping.y(1.0 - (pixel - RangePadding - 0.5) / (canvas.clientHeight - RangePadding * 2.0 - 1.0)),
        valueToAxis: (value: unitValue): number =>
            (1.0 - eventMapping.x(value)) * (canvas.clientHeight - 2.0 * RangePadding - 1.0) + RangePadding + 0.5
    }
    const valueToPixel: Func<unitValue, number> = value => valueAxis.valueToAxis(value) * devicePixelRatio
    const modifyContext = new ObservableModifyContext<ValueModifier>()
    const paintValues = createValuePainter({
        range,
        valueToPixel,
        eventMapping,
        modifyContext,
        snapping,
        valueEditing: context,
        reader
    })
    const painter = lifecycle.own(new CanvasPainter(canvas, paintValues))
    const capturing = createValueEventCapturing(canvas, range, valueAxis.valueToAxis, reader)
    const selectableLocator = createValueSelectionLocator(reader, range, valueAxis, capturing)
    //
    // Register events that must run before any select actions
    //
    lifecycle.ownAll(
        installEditorBody({element: canvas, range, reader}),
        ValueTooltip.install({
            element: canvas,
            capturing,
            range,
            valueAxis,
            reader,
            eventMapping,
            context,
            modifyContext
        }),
        Dragging.attach(canvas, (() => {
            let lastDownTime = 0
            return (event: PointerEvent) => {
                const target: Nullable<ValueCaptureTarget> = capturing.captureEvent(event)
                const altKey = event.altKey
                const now = Date.now()
                const dblclck = now - lastDownTime < Events.DOUBLE_DOWN_THRESHOLD
                lastDownTime = now
                if (dblclck && !event.shiftKey) {
                    if (target === null || target.type === "loop-duration") {
                        const rect = canvas.getBoundingClientRect()
                        const position = snapping.xToUnitRound(event.clientX - rect.left) - reader.offset
                        const clickValue = valueAxis.axisToValue(event.clientY - rect.top)
                        const formatValue = context.currentValue
                        const value: number = Math.abs(valueToPixel(clickValue) - valueToPixel(formatValue))
                        < SnapValueThresholdInPixels
                            ? formatValue
                            : context.quantize(clickValue)
                        return editing.modify(() =>
                            ValueEventEditing.createOrMoveEvent(reader.content, snapping, position, value,
                                context.floating ? Interpolation.Linear : Interpolation.None))
                            .match({
                                none: () => Option.None,
                                some: adapter => {
                                    selection.deselectAll()
                                    selection.select(adapter)
                                    const clientRect = canvas.getBoundingClientRect()
                                    return modifyContext.startModifier(ValueMoveModifier.create({
                                        editing,
                                        element: canvas,
                                        context,
                                        selection,
                                        snapping,
                                        pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top),
                                        pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                                        valueAxis,
                                        eventMapping,
                                        reference: adapter,
                                        collection: reader.content
                                    }))
                                }
                            })
                    } else if (target?.type === "event") {
                        editing.modify(() => ValueEventEditing.deleteEvent(reader.content, target.event))
                        return Option.wrap({update: EmptyExec}) // Avoid selection
                    }
                }
                if (target === null) {
                    if (altKey) {
                        return modifyContext.startModifier(ValuePaintModifier.create({
                            editing,
                            element: canvas,
                            reader,
                            selection,
                            snapping,
                            valueAxis
                        }))
                    }
                } else if (target.type === "midpoint" || target.type === "curve") {
                    if (event.shiftKey) {
                        const clientRect = canvas.getBoundingClientRect()
                        const position: ppqn = range.xToUnit(event.clientX - clientRect.left) - reader.offset
                        const optCutEvent = editing.modify(() => {
                            selection.deselectAll()
                            return reader.content.cut(position, eventMapping).match({
                                none: () => null,
                                some: event => {
                                    selection.select(event)
                                    return event
                                }
                            })
                        }, false).unwrapOrNull()
                        if (optCutEvent === null) {return Option.None}
                        return modifyContext.startModifier(ValueMoveModifier.create({
                            editing,
                            element: canvas,
                            context,
                            selection,
                            snapping,
                            pointerValue: optCutEvent.value,
                            pointerPulse: position + reader.offset,
                            valueAxis,
                            eventMapping,
                            reference: optCutEvent,
                            collection: reader.content
                        }))
                    }
                }
                return Option.None
            }
        })(), {permanentUpdates: false, immediate: true}),
        Dragging.attach(canvas, event => {
            const target = capturing.captureEvent(event)
            if (target?.type !== "loop-duration") {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            return modifyContext.startModifier(ValueContentDurationModifier.create({
                editing,
                element: canvas,
                pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                snapping,
                reference: target.reader
            }))
        }, {permanentUpdates: true})
    )
    const selectionRectangle = (
        <SelectionRectangle lifecycle={lifecycle}
                            target={canvas}
                            selection={selection}
                            locator={selectableLocator}
                            xAxis={range.valueAxis}
                            yAxis={valueAxis}/>
    )
    const element: HTMLElement = (
        <div className={className} tabIndex={-1} onConnect={(self: HTMLElement) => self.focus()}>
            {canvas}
            {selectionRectangle}
        </div>
    )
    const shortcuts = ShortcutManager.get().createContext(element, "ValueEditor")
    lifecycle.ownAll(
        shortcuts,
        shortcuts.register(ContentEditorShortcuts["select-all"].shortcut, () =>
            selection.select(...selectableLocator.selectable())),
        shortcuts.register(ContentEditorShortcuts["deselect-all"].shortcut, () =>
            selection.deselectAll()),
        shortcuts.register(ContentEditorShortcuts["delete-selection"].shortcut, () => {
            const selected = selection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(adapter => ValueEventEditing.deleteEvent(reader.content, adapter)))
            return true
        }),
        Dragging.attach(canvas, (event: PointerEvent) => {
            const target: Nullable<ValueCaptureTarget> = capturing.captureEvent(event)
            if (target === null || selection.isEmpty()) {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            if (target.type === "event") {
                return modifyContext.startModifier(ValueMoveModifier.create({
                    editing,
                    element: canvas,
                    context,
                    selection,
                    snapping,
                    pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top),
                    pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                    valueAxis,
                    eventMapping,
                    reference: target.event,
                    collection: reader.content
                }))
            } else if (target.type === "midpoint") {
                return modifyContext.startModifier(ValueSlopeModifier.create({
                    editing,
                    element: canvas,
                    valueAxis,
                    reference: target.event,
                    collection: reader.content
                }))
            } else {
                return Option.None
            }
        }, {permanentUpdates: true}),
        Html.watchResize(canvas, painter.requestUpdate),
        range.subscribe(painter.requestUpdate),
        reader.subscribeChange(painter.requestUpdate),
        context.anchorModel.subscribe(painter.requestUpdate),
        modifyContext.subscribeUpdate(painter.requestUpdate),
        installCursor(canvas, capturing, {
            get: (target, event) => {
                const onCurve = target?.type === "curve" || target?.type === "midpoint"
                const controlKey = event.altKey && event.buttons === 0
                if (target === null) {
                    if (controlKey) {return Cursor.Pencil}
                } else if (target.type === "event") {
                    return "move"
                } else {
                    if (event.shiftKey && onCurve) {
                        return "pointer"
                    } else if (target.type === "midpoint") {
                        return "ns-resize"
                    } else if (target.type === "loop-duration") {
                        return "ew-resize"
                    }
                }
                return null
            },
            leave: EmptyExec
        }),
        installValueInput({
            element: canvas,
            selection,
            getter: (adapter) => context.stringMapping.x(context.valueMapping.y(eventMapping.x(adapter.value))).value,
            setter: text => {
                const result = context.stringMapping.y(text)
                let value
                if (result.type === "explicit") {
                    value = eventMapping.y(context.valueMapping.x(result.value))
                } else {return}
                editing.modify(() => selection.selected().forEach(adapter => adapter.box.value.setValue(value)))
            }
        }),
        installValueContextMenu({element: canvas, capturing, editing, selection}),
        ClipboardManager.install(element, ValuesClipboard.createHandler({
            getEnabled: () => !engine.isPlaying.getValue(),
            getPosition: () => engine.position.getValue() - reader.offset,
            setPosition: position => engine.setPosition(position + reader.offset),
            editing,
            selection,
            collection: reader.content,
            targetAddress: reader.content.box.events.address,
            boxGraph,
            boxAdapters
        }))
    )
    return element
}