import css from "./ValueEditor.sass?inline"
import {
    clamp,
    DefaultObservableValue,
    EmptyExec,
    Func,
    Lifecycle,
    Nullable,
    Option,
    Selection,
    unitValue,
    ValueAxis
} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {ValueEventBoxAdapter} from "@opendaw/studio-adapters"
import {ValueEventBox} from "@opendaw/studio-boxes"
import {RangePadding} from "@/ui/timeline/editors/value/Constants.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {ValueModifier} from "@/ui/timeline/editors/value/ValueModifier.ts"
import {createValuePainter} from "@/ui/timeline/editors/value/ValuePainter.ts"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@/ui/canvas/painter.ts"
import {createValueEventCapturing, ValueCaptureTarget} from "@/ui/timeline/editors/value/ValueEventCapturing.ts"
import {createValueSelectionLocator} from "@/ui/timeline/editors/value/ValueSelectionLocator.ts"
import {ValuePaintModifier} from "@/ui/timeline/editors/value/ValuePaintModifier.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {SnapValueThresholdInPixels, ValueMoveModifier} from "@/ui/timeline/editors/value/ValueMoveModifier.ts"
import {ValueSlopeModifier} from "@/ui/timeline/editors/value/ValueSlopeModifier.ts"
import {attachShortcuts} from "@/ui/timeline/editors/Shortcuts.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {Cursor} from "@/ui/Cursors.ts"
import {installValueContextMenu} from "@/ui/timeline/editors/value/ValueContextMenu.ts"
import {createElement} from "@opendaw/lib-jsx"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {CutCursor} from "@/ui/timeline/CutCursor.tsx"
import {installValueInput} from "@/ui/timeline/editors/ValueInput.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {installEditorMainBody} from "../EditorBody"
import {ValueEditingContext} from "@/ui/timeline/editors/value/ValueEditingContext.ts"
import {ValueContentDurationModifier} from "./ValueContentDurationModifier"
import {Dragging, Events, Html, Keyboard} from "@opendaw/lib-dom"
import {ValueTooltip} from "./ValueTooltip"
import {ValueEventEditing} from "./ValueEventEditing"
import {TimelineRange} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ValueEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    range: TimelineRange
    snapping: Snapping
    reader: ValueEventOwnerReader
    context: ValueEditingContext
}

export const ValueEditor = ({lifecycle, service, range, snapping, reader, context}: Construct) => {
    const {project} = service
    const {editing} = project

    const selection: Selection<ValueEventBoxAdapter> = lifecycle.own(project.selection
        .createFilteredSelection(box => box instanceof ValueEventBox, {
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
            1.0 - (pixel - RangePadding - 0.5) / (canvas.clientHeight - RangePadding * 2.0 - 1.0),
        valueToAxis: (value: unitValue): number =>
            (1.0 - value) * (canvas.clientHeight - 2.0 * RangePadding - 1.0) + RangePadding + 0.5
    }
    const valueToPixel: Func<unitValue, number> = value => valueAxis.valueToAxis(value) * devicePixelRatio
    const modifyContext = new ObservableModifyContext<ValueModifier>(service.project.editing)
    const cutCursorModel = lifecycle.own(new DefaultObservableValue<Nullable<ppqn>>(null))
    const paintValues = createValuePainter({
        range,
        valueToPixel,
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
        installEditorMainBody({element: canvas, range, reader}),
        ValueTooltip.install({element: canvas, capturing, range, valueAxis, reader, context, modifyContext}),
        Dragging.attach(canvas, (() => {
            let lastDownTime = 0
            return (event: PointerEvent) => {
                const target: Nullable<ValueCaptureTarget> = capturing.captureEvent(event)
                const controlKey = Keyboard.isControlKey(event)
                const now = Date.now()
                const dblclck = now - lastDownTime < Events.DOUBLE_DOWN_THRESHOLD
                lastDownTime = now
                if (dblclck) {
                    if (target === null || target.type === "loop-duration") {
                        const rect = canvas.getBoundingClientRect()
                        const position = snapping.xToUnitRound(event.clientX - rect.left) - reader.offset
                        const clickValue = clamp(valueAxis.axisToValue(event.clientY - rect.top), 0.0, 1.0)
                        const parameter = context.assignment.getValue().unwrap().adapter
                        const formatValue = parameter.getUnitValue()
                        const valueMapping = parameter.valueMapping
                        const value: unitValue = Math.abs(valueToPixel(clickValue) - valueToPixel(formatValue))
                        < SnapValueThresholdInPixels
                            ? formatValue
                            : valueMapping.x(valueMapping.y(clickValue))
                        return editing.modify(() =>
                            ValueEventEditing.createOrMoveEvent(reader.content, snapping, position, value,
                                valueMapping.floating() ? Interpolation.Linear : Interpolation.None))
                            .match({
                                none: () => Option.None,
                                some: adapter => {
                                    selection.deselectAll()
                                    selection.select(adapter)
                                    const clientRect = canvas.getBoundingClientRect()
                                    return modifyContext.startModifier(ValueMoveModifier.create({
                                        element: canvas,
                                        parameter: context.assignment.getValue().unwrap().adapter,
                                        selection,
                                        snapping,
                                        pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top),
                                        pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                                        valueAxis,
                                        reference: adapter,
                                        collection: reader.content
                                    }))
                                }
                            })
                    } else {
                        editing.modify(() => ValueEventEditing.deleteEvent(reader.content, target.event))
                        return Option.wrap({update: EmptyExec}) // Avoid selection
                    }
                }
                if (target === null) {
                    if (controlKey) {
                        return modifyContext.startModifier(ValuePaintModifier.create({
                            element: canvas,
                            reader,
                            selection,
                            snapping, valueAxis
                        }))
                    }
                } else if (target.type === "curve") {
                    if (event.altKey) {
                        const clientRect = canvas.getBoundingClientRect()
                        const position: ppqn = snapping.xToUnitRound(event.clientX - clientRect.left) - reader.offset
                        editing.modify(() => reader.content.cut(position).unwrapOrNull())
                            .ifSome(event => {
                                selection.deselectAll()
                                selection.select(event)
                            })
                        return Option.wrap({update: EmptyExec}) // Avoid selection
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
    lifecycle.ownAll(
        Dragging.attach(canvas, (event: PointerEvent) => {
            const target: Nullable<ValueCaptureTarget> = capturing.captureEvent(event)
            if (target === null || selection.isEmpty()) {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            if (target.type === "event") {
                return modifyContext.startModifier(ValueMoveModifier.create({
                    element: canvas,
                    parameter: context.assignment.getValue().unwrap().adapter,
                    selection,
                    snapping,
                    pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top),
                    pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                    valueAxis,
                    reference: target.event,
                    collection: reader.content
                }))
            } else if (target.type === "curve") {
                return modifyContext.startModifier(ValueSlopeModifier.create({
                    element: canvas,
                    selection,
                    pointerValue: valueAxis.axisToValue(event.clientY - clientRect.top),
                    valueAxis,
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
        attachShortcuts(canvas, editing, selection, selectableLocator),
        installCursor(canvas, capturing, {
            get: (target, event) => {
                cutCursorModel.setValue(target?.type === "curve" && event.altKey
                    ? snapping.xToUnitRound(event.clientX - canvas.getBoundingClientRect().left)
                    : null)
                const controlKey = Keyboard.isControlKey(event) && event.buttons === 0
                if (target === null) {
                    if (controlKey) {return Cursor.Pencil}
                } else if (target.type === "event") {
                    return "move"
                } else if (target.type === "curve") {
                    return event.altKey ? Cursor.Scissors : "ns-resize"
                } else if (target.type === "loop-duration") {
                    return "ew-resize"
                }
                return null
            },
            leave: () => cutCursorModel.setValue(null)
        }),
        installValueInput({
            element: canvas,
            selection,
            getter: (adapter) => context.stringMapping.x(context.valueMapping.y(adapter.value)).value,
            setter: text => {
                const result = context.stringMapping.y(text)
                let value
                if (result.type === "unitValue") {
                    value = result.value
                } else if (result.type === "explicit") {
                    value = context.valueMapping.x(result.value)
                } else {return}
                editing.modify(() => selection.selected().forEach(adapter => adapter.box.value.setValue(clamp(value, 0.0, 1.0))))
            }
        }),
        installValueContextMenu({element: canvas, capturing, editing, selection})
    )
    return (
        <div className={className}>
            {canvas}
            {selectionRectangle}
            <CutCursor lifecycle={lifecycle} position={cutCursorModel} range={range}/>
        </div>
    )
}