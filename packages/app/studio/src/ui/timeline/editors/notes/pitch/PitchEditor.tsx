import css from "./PitchEditor.sass?inline"
import {
    byte,
    isInstanceOf,
    isNotNull,
    isNull,
    Lifecycle,
    MutableObservableValue,
    Nullable,
    Option,
    panic,
    Procedure,
    Selection,
    unitValue,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {PanDragging} from "@/ui/timeline/PanDragging"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter, ContextMenu, Project, StudioPreferences, TimelineRange} from "@opendaw/studio-core"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {PitchPositioner} from "./PitchPositioner.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {Scroller} from "@/ui/components/Scroller.tsx"
import {createNotePitchPainter} from "@/ui/timeline/editors/notes/pitch/PitchPainter.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {BoxAdapters, NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteContentDurationModifier} from "@/ui/timeline/editors/notes/NoteContentDurationModifier.ts"
import {Cursor} from "@/ui/Cursors.ts"
import {createPitchEventCapturing, PitchCaptureTarget} from "@/ui/timeline/editors/notes/pitch/PitchEventCapturing.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {createPitchSelectionLocator} from "@/ui/timeline/editors/notes/pitch/PitchSelectionLocator.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {NoteMoveModifier} from "@/ui/timeline/editors/notes/NoteMoveModifier.ts"
import {NoteDurationModifier} from "@/ui/timeline/editors/notes/NoteDurationModifier.ts"
import {installContextMenu} from "@/ui/timeline/editors/notes/pitch/PitchContextMenu.ts"
import {NoteEventBox} from "@opendaw/studio-boxes"
import {NoteCreateModifier} from "@/ui/timeline/editors/notes/NoteCreateModifier.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Browser, CssUtils, Dragging, Events, Html, ShortcutManager} from "@opendaw/lib-dom"
import {ppqn} from "@opendaw/lib-dsp"
import {Surface} from "@/ui/surface/Surface"
import {NoteEditorShortcuts} from "@/ui/shortcuts/NoteEditorShortcuts"
import {NoteDrawDefaults} from "@/ui/timeline/editors/notes/NoteDrawDefaults.ts"
import {ContentEditorShortcuts} from "@/ui/shortcuts/ContentEditorShortcuts"

const className = Html.adoptStyleSheet(css, "PitchEditor")

const CursorMap = {
    "note-end": "e-resize",
    "note-position": "default",
    "loop-duration": "ew-resize"
} satisfies Record<PitchCaptureTarget["type"], CssUtils.Cursor>

type Construct = {
    lifecycle: Lifecycle
    project: Project
    boxAdapters: BoxAdapters
    range: TimelineRange
    snapping: Snapping
    positioner: PitchPositioner
    scale: ScaleConfig
    selection: Selection<NoteEventBoxAdapter>
    modifyContext: ObservableModifyContext<NoteModifier>
    reader: NoteEventOwnerReader
    stepRecording: MutableObservableValue<boolean>
}

export const PitchEditor = ({
                                lifecycle, project, boxAdapters, range, snapping,
                                positioner, scale, selection, modifyContext, reader, stepRecording
                            }: Construct) => {
    let previewNote: Nullable<{ pitch: byte, position: ppqn, duration: ppqn, velocity: unitValue }> = null
    const {editing} = project
    const canvas: HTMLCanvasElement = <canvas tabIndex={-1}/>
    const capturing = createPitchEventCapturing(canvas, positioner, range, reader)
    const locator = createPitchSelectionLocator(reader, range, positioner.valueAxis, capturing)
    const pitchPainter = createNotePitchPainter(
        {canvas, modifyContext, positioner, scale, range, snapping, reader})
    const renderer = lifecycle.own(new CanvasPainter(canvas, painter => {
        if (isNotNull(previewNote)) {
            const position = previewNote.position
            const complete = position + previewNote.duration
            const {context} = painter
            const x0 = Math.floor(range.unitToX(position + reader.offset) + 1) * devicePixelRatio
            const x1 = Math.floor(range.unitToX(complete + reader.offset) * devicePixelRatio)
            const y0 = positioner.pitchToY(previewNote.pitch) * devicePixelRatio
            const y1 = y0 + (positioner.noteHeight - 1) * devicePixelRatio
            context.fillStyle = "rgba(255, 255, 255, 0.08)"
            context.fillRect(x0, y0, x1 - x0, y1 - y0)
        }
        pitchPainter(painter)
    }))
    const auditionNote = (pitch: byte, duration: ppqn, velocity: unitValue) => {
        if (!StudioPreferences.settings.engine["note-audition-while-editing"]) {return}
        project.engine.noteSignal({
            type: "note-audition",
            uuid: reader.trackBoxAdapter.unwrap("trackBoxAdapter").audioUnit.address.uuid, pitch, duration, velocity
        })
    }
    const createNoteAt = (clientX: number, clientY: number): Option<NoteEventBoxAdapter> => {
        const rect = canvas.getBoundingClientRect()
        const pulse = snapping.floor(range.xToUnit(clientX - rect.left)) - reader.offset
        const pitch = positioner.yToPitch(clientY - rect.top)
        const duration = NoteDrawDefaults.durationOr(snapping.value(reader.position + pulse))
        const velocity = NoteDrawDefaults.velocity
        // Create AND select in one modify so the selection lands in the same undo entry as the create (#208)
        const adapterOpt = editing.modify(() => {
            const box = NoteEventBox.create(project.boxGraph, UUID.generate(), box => {
                box.position.setValue(pulse)
                box.pitch.setValue(pitch)
                box.duration.setValue(duration)
                box.velocity.setValue(velocity)
                box.events.refer(reader.content.box.events)
            })
            const adapter = boxAdapters.adapterFor(box, NoteEventBoxAdapter)
            selection.deselectAll()
            selection.select(adapter)
            return adapter
        })
        if (adapterOpt.nonEmpty()) {auditionNote(pitch, duration, velocity)}
        return adapterOpt
    }
    const deleteDragging = (event: PointerEvent): void => {
        let deletedAny = false
        let lastX = event.clientX, lastY = event.clientY
        const deleteAt = (clientX: number, clientY: number): void => {
            const target = capturing.captureEvent({clientX, clientY})
            if (target?.type !== "note-position" && target?.type !== "note-end") {return}
            const deletion = () => target.event.box.delete()
            if (deletedAny) {editing.append(deletion)} else {editing.modify(deletion)}
            deletedAny = true
        }
        deleteAt(lastX, lastY)
        const gesture = new Terminator()
        gesture.ownAll(
            Events.subscribe(window, "pointermove", (move: PointerEvent) => {
                if ((move.buttons & 2) === 0) {return gesture.terminate()}
                const steps = Math.max(1, Math.ceil(Math.hypot(move.clientX - lastX, move.clientY - lastY) / 2))
                for (let step = 1; step <= steps; step++) {
                    deleteAt(lastX + (move.clientX - lastX) * step / steps, lastY + (move.clientY - lastY) * step / steps)
                }
                lastX = move.clientX
                lastY = move.clientY
            }),
            Events.subscribe(window, "pointerup", () => gesture.terminate()),
            Events.subscribe(window, "pointercancel", () => gesture.terminate())
        )
    }
    let flMenuRequested = false
    // before selection
    lifecycle.ownAll(
        Events.subscribe(canvas, "pointerdown", (event: PointerEvent) => {
            if (!WheelScaling.isFlStudioMode()) {return}
            const target = capturing.captureEvent(event)
            const onNote = target?.type === "note-position" || target?.type === "note-end"
            if (event.button === 2) {
                deleteDragging(event)
            } else if (event.button === 0 && event.ctrlKey && onNote) {
                event.preventDefault()
                flMenuRequested = true
                if (!Browser.isMacOS()) {
                    canvas.dispatchEvent(new MouseEvent("contextmenu", {
                        bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, ctrlKey: true
                    }))
                }
            }
        }),
        PanDragging.install(canvas, (deltaX, deltaY) => {
            range.moveUnitBy(-deltaX * range.unitsPerPixel)
            positioner.moveBy(-deltaY)
        }),
        Events.subscribeAny(canvas, ContextMenu.CONTEXT_MENU_EVENT_TYPE, (event: Event) => {
            if (WheelScaling.isFlStudioMode() && !flMenuRequested) {event.stopImmediatePropagation()}
            flMenuRequested = false
        }, {capture: true}),
        installAutoScroll(canvas, (_deltaX, deltaY) => {
            // A create drag reads the vertical distance as velocity and keeps the pitch it started on
            if (modifyContext.modifier.mapOr(modifier => isInstanceOf(modifier, NoteCreateModifier), false)) {return}
            if (deltaY !== 0) {positioner.moveBy(deltaY * 0.05)}
        }, {padding: Config.AutoScrollPadding}),
        Dragging.attach(canvas, event => {
            const target = capturing.captureEvent(event)
            if (target?.type !== "loop-duration") {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            return modifyContext.startModifier(NoteContentDurationModifier.create({
                editing,
                element: canvas,
                pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                snapping,
                reference: target.reader
            }))
        }, {permanentUpdates: true}),
        Dragging.attach(canvas, event => {
            if (!event.altKey) {return Option.None}
            const target = capturing.captureEvent(event)
            if (target !== null) {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            const pitch = positioner.yToPitch(event.clientY - clientRect.top)
            const modifier = NoteCreateModifier.create({
                editing,
                element: canvas,
                pointerPulse: range.xToUnit(event.clientX - clientRect.left) - reader.offset,
                pointerPitch: pitch,
                pointerClientY: event.clientY,
                selection,
                snapping,
                reference: reader
            })
            auditionNote(pitch, modifier.note.duration, modifier.note.velocity)
            return modifyContext.startModifier(modifier)
        }, {permanentUpdates: true}),
        Dragging.attach(canvas, event => {
            if (!WheelScaling.isFlStudioMode() || event.ctrlKey || event.altKey || event.shiftKey) {return Option.None}
            if (capturing.captureEvent(event) !== null) {return Option.None}
            return createNoteAt(event.clientX, event.clientY).flatMap(adapter => {
                const clientRect = canvas.getBoundingClientRect()
                const modifier = NoteMoveModifier.create({
                    editing,
                    element: canvas,
                    selection,
                    positioner,
                    pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                    pointerPitch: positioner.yToPitch(event.clientY - clientRect.top),
                    snapping,
                    reference: adapter
                })
                modifier.subscribePitchChanged(pitch => auditionNote(pitch, adapter.duration, adapter.velocity))
                return modifyContext.startModifier(modifier)
            })
        }, {permanentUpdates: true}))
    const selectionRectangle = (
        <SelectionRectangle lifecycle={lifecycle}
                            target={canvas}
                            selection={selection}
                            locator={locator}
                            xAxis={range.valueAxis}
                            yAxis={positioner.valueAxis}/>
    )
    const modifySelection = (procedure: Procedure<NoteEventBoxAdapter>): boolean => {
        const adapters = selection.selected()
        if (adapters.length === 0) {return false}
        const first = adapters[0]
        editing.modify(() => adapters.forEach(procedure))
        auditionNote(first.pitch, first.duration, first.velocity)
        return true
    }
    const updatePreview = (): void => {
        const point = Surface.get(canvas).pointer
        const captureEvent = capturing.captureEvent({clientX: point.x, clientY: point.y})
        if (isNull(captureEvent)) {
            const rect = canvas.getBoundingClientRect()
            const pitch = positioner.yToPitch(point.y - rect.top)
            const position = snapping.xToUnitFloor(point.x - rect.left) - reader.offset
            const duration = NoteDrawDefaults.durationOr(snapping.value(position + reader.offset))
            const velocity = NoteDrawDefaults.velocity
            if (isNotNull(previewNote)) {
                if (previewNote.pitch === pitch
                    && previewNote.position === position
                    && previewNote.duration === duration
                    && previewNote.velocity === velocity) {
                    return
                }
            }
            // check if equal > return
            previewNote = {pitch, position, duration, velocity}
        } else {
            previewNote = null
        }
        renderer.requestUpdate()
    }
    const shortcuts = ShortcutManager.get().createContext(canvas, "PitchEditor")
    lifecycle.ownAll(
        shortcuts,
        shortcuts.register(NoteEditorShortcuts["increment-note-semitone"].shortcut, () =>
            modifySelection(({box, pitch}: NoteEventBoxAdapter) => box.pitch.setValue(Math.min(pitch + 1, 127)))),
        shortcuts.register(NoteEditorShortcuts["decrement-note-semitone"].shortcut, () =>
            modifySelection(({box, pitch}: NoteEventBoxAdapter) => box.pitch.setValue(Math.max(pitch - 1, 0)))),
        shortcuts.register(NoteEditorShortcuts["increment-note-octave"].shortcut, () =>
            modifySelection(({box, pitch}: NoteEventBoxAdapter) => {
                if (pitch + 12 <= 127) {box.pitch.setValue(pitch + 12)}
            }), {allowRepeat: true}),
        shortcuts.register(NoteEditorShortcuts["decrement-note-octave"].shortcut, () =>
            modifySelection(({box, pitch}: NoteEventBoxAdapter) => {
                if (pitch - 12 >= 0) {box.pitch.setValue(pitch - 12)}
            }), {allowRepeat: true}),
        shortcuts.register(NoteEditorShortcuts["increment-note-position"].shortcut, () =>
            modifySelection(({box, position}: NoteEventBoxAdapter) =>
                box.position.setValue(position + snapping.value(reader.position + position))), {allowRepeat: true}),
        shortcuts.register(NoteEditorShortcuts["decrement-note-position"].shortcut, () =>
            modifySelection(({box, position}: NoteEventBoxAdapter) =>
                box.position.setValue(position - snapping.value(reader.position + position))), {allowRepeat: true}),
        shortcuts.register(ContentEditorShortcuts["select-all"].shortcut, () => selection.select(...locator.selectable())),
        shortcuts.register(ContentEditorShortcuts["deselect-all"].shortcut, () => selection.deselectAll()),
        shortcuts.register(ContentEditorShortcuts["delete-selection"].shortcut, () => {
            const selected = selection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(adapter => adapter.box.delete()))
            return true
        }),
        Html.watchResize(canvas, () => range.width = canvas.clientWidth),
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            if (WheelScaling.isZoomGesture(event) || event.altKey) {return}
            event.preventDefault()
            positioner.scrollModel.moveBy(event.deltaY)
        }, {passive: false}),
        Events.subscribeDblDwn(canvas, event => {
            if (WheelScaling.isFlStudioMode()) {return}
            const target = capturing.captureEvent(event)
            if (target === null) {
                createNoteAt(event.clientX, event.clientY)
            } else if (target.type !== "loop-duration") {
                editing.modify(() => target.event.box.delete())
            }
        }),
        Dragging.attach(canvas, (event: PointerEvent) => {
            const target: Nullable<PitchCaptureTarget> = capturing.captureEvent(event)
            if (target === null || selection.isEmpty()) {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            if (target.type === "note-position") {
                const noteEventBoxAdapter = target.event
                const {pitch, duration, velocity} = noteEventBoxAdapter
                auditionNote(pitch, duration, velocity)
                const modifier = NoteMoveModifier.create({
                    editing,
                    element: canvas,
                    selection,
                    positioner,
                    pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                    pointerPitch: positioner.yToPitch(event.clientY - clientRect.top),
                    snapping,
                    reference: noteEventBoxAdapter
                })
                modifier.subscribePitchChanged(pitch => auditionNote(pitch, duration, velocity))
                return modifyContext.startModifier(modifier)
            } else if (target.type === "note-end") {
                const noteEventBoxAdapter = target.event
                const {pitch, duration, velocity} = noteEventBoxAdapter
                auditionNote(pitch, duration, velocity)
                return modifyContext.startModifier(NoteDurationModifier.create({
                    editing,
                    element: canvas,
                    selection,
                    pointerPulse: range.xToUnit(event.clientX - clientRect.left),
                    snapping,
                    reference: target.event
                }))
            } else {
                return panic("Unknown capture")
            }
        }, {permanentUpdates: true}),
        installContextMenu({
            element: canvas,
            snapping,
            selection,
            capturing,
            editing,
            events: reader.content.events,
            stepRecording,
            api: project.api,
            keyAt: position => reader.timelineBoxAdapter.keyTrack.keyAt(position + reader.offset)
        }),
        positioner.subscribe(renderer.requestUpdate),
        range.subscribe(renderer.requestUpdate),
        reader.timelineBoxAdapter.signatureTrack.subscribe(renderer.requestUpdate),
        snapping.subscribe(renderer.requestUpdate),
        scale.subscribe(renderer.requestUpdate),
        reader.subscribeChange(renderer.requestUpdate),
        modifyContext.subscribeUpdate(renderer.requestUpdate),
        Events.subscribe(canvas, "pointermove", event => {
            canvas.focus({preventScroll: true})
            if (event.altKey && event.buttons === 0) {
                updatePreview()
            }
        }),
        Events.subscribe(canvas, "pointerleave", () => {
            previewNote = null
            renderer.requestUpdate()
        }),
        installCursor(canvas, capturing, {
            get: (target, event) =>
                target === null ? event.altKey && event.buttons === 0
                    ? Cursor.Pencil
                    : null : CursorMap[target.type]
        }),
        Events.subscribe(canvas, "keyup", () => {
            previewNote = null
            renderer.requestUpdate()
        }),
        Events.subscribe(canvas, "keydown", event => {
            if (event.altKey) {
                updatePreview()
                return
            }
        })
    )
    return (
        <div className={className} tabIndex={-1}>
            {canvas}
            <Scroller lifecycle={lifecycle}
                      model={positioner.scrollModel}
                      floating/>
            {selectionRectangle}
        </div>
    )
}