import css from "./RegionBound.sass?inline"
import {Lifecycle, Nullable, Option, Terminable, Terminator, Unhandled} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {CanvasPainter, RegionModifyStrategy, TimelineRange} from "@opendaw/studio-core"
import {LoopableRegion} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, RegionAdapters, UnionBoxTypes} from "@opendaw/studio-adapters"
import {CaptureTarget, createRegionCapturing} from "@/ui/timeline/editors/RegionCapturingTarget.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {Context2d, CssUtils, Dragging, Html} from "@opendaw/lib-dom"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {RegionModifyContext} from "@/ui/timeline/editors/RegionModifyContext.ts"
import {RegionStartModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionStartModifier.ts"
import {RegionDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionDurationModifier.ts"
import {RegionLoopDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionLoopDurationModifier.ts"
import {RegionMoveInTrackModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionMoveInTrackModifier.ts"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {Cursor} from "@/ui/Cursors.ts"
import {TimelineLabels} from "@/ui/timeline/TimelineLabels"

const className = Html.adoptStyleSheet(css, "RegionBound")

const CursorMap = Object.freeze({
    "region-position": "auto",
    "region-start": Cursor.LoopStart,
    "region-complete": Cursor.LoopEnd,
    "loop-duration": Cursor.ExpandWidth
}) satisfies Record<CaptureTarget["type"], CssUtils.Cursor | Cursor>

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    range: TimelineRange
    snapping: Snapping
    modifyContext: RegionModifyContext
}

export const RegionBound = ({lifecycle, service, range, snapping, modifyContext}: Construct) => {
    const regionSubscriber = lifecycle.own(new Terminator())
    const {project} = service
    const {regionSelection} = project
    const editingRegion = project.userEditingManager.timeline
    const canvas: HTMLCanvasElement = <canvas/>
    let current: Option<AnyRegionBoxAdapter> = Option.None
    const capturing = createRegionCapturing(canvas, () => current, range)
    const {requestUpdate} = lifecycle.own(new CanvasPainter(canvas, painter => {
        if (current.isEmpty()) {return}
        const editingRegion = current.unwrap()
        const {height, context} = painter
        const {fontFamily, fontSize} = getComputedStyle(canvas)
        const em = Math.ceil(parseFloat(fontSize) * devicePixelRatio)
        context.textBaseline = "middle"
        context.font = `${em}px ${fontFamily}`

        const unitMin = range.unitMin - range.unitPadding
        const unitMax = range.unitMax
        const collection = editingRegion.trackBoxAdapter.unwrap("trackBoxAdapter").regions.collection
        const renderRegions = (strategy: RegionModifyStrategy, modified: boolean): void => {
            for (const region of strategy.iterateRange(collection, unitMin, unitMax)) {
                if (modifyContext.isModifying(region) !== modified) {continue}
                const position = strategy.readPosition(region)
                const complete = strategy.readComplete(region)
                const loopOffset = strategy.readLoopOffset(region)
                const loopDuration = strategy.readLoopDuration(region)
                for (const pass of LoopableRegion.locateLoops(
                    {position, complete, loopOffset, loopDuration}, unitMin, unitMax)) {
                    const x0 = Math.floor((range.unitToX(pass.resultStart) + 1) * devicePixelRatio)
                    const x1 = Math.floor(range.unitToX(pass.resultEnd) * devicePixelRatio)
                    const alpha = pass.index === 0 ? 0.5 : 0.25
                    context.fillStyle = `hsla(${region.hue}, 60%, 30%, ${alpha})`
                    context.fillRect(x0, 0, x1 - x0, height * devicePixelRatio)
                }
                const offset = position - loopOffset
                const x0 = Math.floor((range.unitToX(position) + 3) * devicePixelRatio)
                const x1 = Math.floor((range.unitToX(
                    offset + Math.min(complete - position, loopDuration)) - 1) * devicePixelRatio)
                context.fillStyle = `hsl(${region.hue}, 60%, 60%)`
                const {text} = Context2d.truncateText(context, TimelineLabels.forRegion(region), x1 - x0)
                context.fillText(text, x0, height * devicePixelRatio / 2.0 + 1)
            }
        }
        const strategies = modifyContext.strategies()
        renderRegions(strategies.unselectedModifyStrategy(), false)
        renderRegions(strategies.selectedModifyStrategy(), true)

        const strategy = modifyContext.strategyFor(editingRegion)
        const position = strategy.readPosition(editingRegion)
        const complete = strategy.readComplete(editingRegion)
        const offset = position - strategy.readLoopOffset(editingRegion)
        const x0 = Math.floor((range.unitToX(position) + 1.5) * devicePixelRatio)
        const x1 = Math.floor((range.unitToX(
            Math.min(offset + strategy.readLoopDuration(editingRegion), complete)) - 0.5) * devicePixelRatio)
        context.strokeStyle = `hsl(${editingRegion.hue}, 60%, 30%)`
        context.lineWidth = devicePixelRatio
        context.strokeRect(x0, 1, x1 - x0, (height - 1) * devicePixelRatio)
    }))

    const listenToRegion = (region: AnyRegionBoxAdapter): Terminable => {
        return Terminable.many(
            region.trackBoxAdapter.unwrap("trackBoxAdapter").regions.subscribeChanges(requestUpdate),
            region.box.regions.subscribe(() => {
                if (region.trackBoxAdapter.nonEmpty()) {
                    listenToRegion(region)
                }
            })
        )
    }
    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        editingRegion.catchupAndSubscribe(option => {
            regionSubscriber.terminate()
            current = option.flatMap(vertex => {
                if (UnionBoxTypes.isRegionBox(vertex.box)) {
                    return Option.wrap(RegionAdapters.for(service.project.boxAdapters, vertex.box))
                } else {
                    return Option.None
                }
            })
            if (current.nonEmpty()) {
                regionSubscriber.own(listenToRegion(current.unwrap()))
            }
            requestUpdate()
        }),
        modifyContext.subscribeUpdate(requestUpdate),
        installAutoScroll(canvas, (deltaX, _deltaY) => {
            if (deltaX !== 0) {range.moveUnitBy(deltaX * range.unitsPerPixel * Config.AutoScrollHorizontalSpeed)}
        }, {padding: Config.AutoScrollPadding}),
        Dragging.attach(canvas, (event: PointerEvent) => {
            const target: Nullable<CaptureTarget> = capturing.captureEvent(event)
            if (target === null) {return Option.None}
            const {region} = target
            const frozen = region.trackBoxAdapter
                .mapOr(track => project.audioUnitFreeze.isFrozenUuid(track.audioUnit.address.uuid), true)
            if (frozen) {return Option.None}
            const clientRect = canvas.getBoundingClientRect()
            const pointerPulse = range.xToUnit(event.clientX - clientRect.left)
            // The overlap resolvers skip regions flagged as selected, so an unselected region would be
            // clipped against its own mask on approve (RegionClipResolver.createTasksFromMasks).
            regionSelection.deselectAll()
            regionSelection.select(region)
            const construct = {project, element: canvas, snapping, pointerPulse, reference: region}
            const modifier: Option<RegionModifier> = ((): Option<RegionModifier> => {
                switch (target.type) {
                    case "region-start":
                        return RegionStartModifier.create([region], construct)
                    case "region-complete":
                        return RegionDurationModifier.create([region], {
                            project, element: canvas, snapping, pointerPulse,
                            bounds: [region.position, region.complete]
                        })
                    case "loop-duration":
                        return RegionLoopDurationModifier.create([region], {...construct, resize: false})
                    case "region-position":
                        return RegionMoveInTrackModifier.create([region], construct)
                    default:
                        return Unhandled(target)
                }
            })()
            return modifyContext.startModifier(region, modifier).map(process => ({
                ...process,
                // Bringing the region into edit-mode re-zooms the range (ContentEditor), which would pull the
                // ground out from under the running modifier, so the switch waits until the gesture is over.
                // It is sealed into its own history entry: `edit` writes unmarked, and a leftover unmarked
                // pending is folded into the NEXT marked modify, so an unsealed switch would ride along with
                // whatever the user edits next and undoing that edit would jump the editor back (#298).
                finally: () => {
                    process.finally?.call(process)
                    const {editing, userEditingManager: {timeline}} = project
                    if (!timeline.isEditing(region.box)) {editing.modify(() => timeline.edit(region.box))}
                }
            }))
        }, {permanentUpdates: true}),
        installCursor(canvas, capturing, {get: target => target === null ? null : CursorMap[target.type]})
    )
    return (
        <div className={className}>
            {canvas}
        </div>
    )
}