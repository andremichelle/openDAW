import {int, Iterables, Option, unitValue} from "@opendaw/lib-std"
import {LoopableRegion, ValueEvent} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, NoteRegionBoxAdapter, ValueRegionBoxAdapter} from "@opendaw/studio-adapters"
import {
    AudioFadingRenderer,
    AudioRenderer,
    NotesRenderer,
    RegionBound,
    RegionModifyStrategies,
    RegionModifyStrategy,
    TimeGrid,
    TimelineRange,
    ValueStreamRenderer
} from "@opendaw/studio-core"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {Context2d} from "@opendaw/lib-dom"
import {RegionPaintBucket} from "@/ui/timeline/tracks/audio-unit/regions/RegionPaintBucket"
import {RegionLabel} from "@/ui/timeline/RegionLabel"

export const renderRegions = (context: CanvasRenderingContext2D,
                              tracks: TracksManager,
                              range: TimelineRange,
                              index: int): void => {
    const canvas = context.canvas
    const {width, height} = canvas
    const {fontFamily} = getComputedStyle(canvas)

    // subtract one pixel to avoid making special cases for a possible outline
    const unitMin = range.unitMin - range.unitPadding - range.unitsPerPixel
    const unitMax = range.unitMax

    const dpr = devicePixelRatio
    const fontSize = RegionLabel.fontSize() * dpr
    const labelHeight = RegionLabel.labelHeight() * dpr
    const bound: RegionBound = {top: labelHeight + 1.0, bottom: height - 2.5}

    context.clearRect(0, 0, width, height)
    context.textBaseline = "middle"
    context.font = `${fontSize}px ${fontFamily}`

    const grid = true
    if (grid) {
        const {timelineBoxAdapter: {signatureTrack}} = tracks.service.project
        context.fillStyle = "rgba(0, 0, 0, 0.3)"
        TimeGrid.fragment(
            signatureTrack,
            range,
            ({pulse}) => {
                const x0 = Math.floor(range.unitToX(pulse)) * dpr
                context.fillRect(x0, 0, dpr, height)
            },
            {minLength: 32}
        )
    }
    const renderRegions = (strategy: RegionModifyStrategy, filterSelected: boolean, hideSelected: boolean): void => {
        const optTrack = tracks.getByIndex(strategy.translateTrackIndex(index))
        if (optTrack.isEmpty()) {return}
        const trackBoxAdapter = optTrack.unwrap().trackBoxAdapter
        const trackDisabled = !trackBoxAdapter.enabled.getValue()
        const regions = strategy.iterateRange(trackBoxAdapter.regions.collection, unitMin, unitMax)
        for (const [region, next] of Iterables.pairWise(regions)) {
            if (region.isSelected ? hideSelected : !filterSelected) {continue}
            const actualComplete = strategy.readComplete(region)
            const position = strategy.readPosition(region)
            const complete = region.isSelected
                ? actualComplete
                : // for no-stretched audio region
                Math.min(actualComplete, next?.position ?? Number.POSITIVE_INFINITY)
            const x0Int = Math.floor(range.unitToX(Math.max(position, unitMin))) * dpr
            const x1Int = Math.max(Math.floor(range.unitToX(Math.min(complete, unitMax)) - 1) * dpr, x0Int + dpr)
            const xnInt = x1Int - x0Int
            const {labelColor, labelBackground, contentColor, contentBackground, loopStrokeColor} =
                RegionPaintBucket.create(region, region.isSelected && !filterSelected, trackDisabled)
            context.clearRect(x0Int, 0, xnInt, height)
            context.fillStyle = labelBackground
            context.fillRect(x0Int, 0, xnInt, labelHeight)
            context.fillStyle = contentBackground
            context.fillRect(x0Int, labelHeight, xnInt, height - labelHeight)
            const maxTextWidth = xnInt - 3 * dpr // subtract text-padding
            context.fillStyle = labelColor
            if (strategy.readMirror(region)) {
                context.font = `italic ${fontSize}px ${fontFamily}`
            } else {
                context.font = `${fontSize}px ${fontFamily}`
            }
            const text = region.label.length === 0 ? "◻" : region.label
            context.fillText(Context2d.truncateText(context, text, maxTextWidth).text, x0Int + 3 * dpr, 1 + labelHeight / 2)
            if (!region.hasCollection) {continue}
            context.fillStyle = contentColor
            region.accept({
                visitNoteRegionBoxAdapter: (region: NoteRegionBoxAdapter): void => {
                    for (const pass of LoopableRegion.locateLoops({
                        position, complete,
                        loopOffset: strategy.readLoopOffset(region),
                        loopDuration: strategy.readLoopDuration(region)
                    }, unitMin, unitMax)) {
                        if (pass.index > 0) {
                            const x = Math.floor(range.unitToX(pass.resultStart) * dpr)
                            context.fillStyle = loopStrokeColor
                            context.fillRect(x, labelHeight, 1, height - labelHeight)
                        }
                        NotesRenderer.render(context, range, region, bound, contentColor, pass)
                    }
                },
                visitAudioRegionBoxAdapter: (region: AudioRegionBoxAdapter): void => {
                    for (const pass of LoopableRegion.locateLoops({
                        position, complete,
                        loopOffset: strategy.readLoopOffset(region),
                        loopDuration: strategy.readLoopDuration(region)
                    }, unitMin, unitMax)) {
                        if (pass.index > 0) {
                            const x = Math.floor(range.unitToX(pass.resultStart) * dpr)
                            context.fillStyle = loopStrokeColor
                            context.fillRect(x, labelHeight, 1, height - labelHeight)
                        }
                        const tempoMap = region.trackBoxAdapter.unwrap().context.tempoMap
                        AudioRenderer.render(context, range, region.file, tempoMap,
                            region.observableOptPlayMode, region.waveformOffset.getValue(),
                            region.gain.getValue(), bound, contentColor, pass
                        )
                    }
                    AudioFadingRenderer.render(context, range, region.fading, bound, position, complete, labelBackground)
                    const isRecording = region.file.getOrCreateLoader().state.type === "record"
                    if (isRecording) {}
                },
                visitValueRegionBoxAdapter: (region: ValueRegionBoxAdapter) => {
                    const padding = dpr
                    const top = labelHeight + padding
                    const bottom = height - padding * 2
                    context.save()
                    context.beginPath()
                    context.rect(x0Int + padding, top, x1Int - x0Int - padding, bottom - top + padding)
                    context.clip()
                    const valueToY = (value: unitValue): number => bottom + value * (top - bottom)
                    const events = region.events.unwrap()
                    for (const pass of LoopableRegion.locateLoops({
                        position, complete,
                        loopOffset: strategy.readLoopOffset(region),
                        loopDuration: strategy.readLoopDuration(region)
                    }, unitMin, unitMax)) {
                        if (pass.index > 0) {
                            const x = Math.floor(range.unitToX(pass.resultStart) * dpr)
                            context.fillStyle = loopStrokeColor
                            context.fillRect(x, labelHeight, 1, height - labelHeight)
                        }
                        const windowMin = pass.resultStart - pass.rawStart
                        const windowMax = pass.resultEnd - pass.rawStart
                        context.strokeStyle = contentColor
                        context.beginPath()
                        const adapters = ValueEvent.iterateWindow(events, windowMin, windowMax)
                        ValueStreamRenderer.render(context, range, adapters, valueToY, contentColor, 0.2, 0.0, pass)
                        context.stroke()
                    }
                    context.restore()
                }
            })
            const isEditing = tracks.service.project.userEditingManager.timeline.isEditing(region.box)
            if (isEditing) {
                context.fillStyle = labelBackground
                context.fillRect(x1Int - dpr, labelHeight, dpr, height - labelHeight - dpr)
                context.fillRect(x0Int, labelHeight, dpr, height - labelHeight - dpr)
                context.fillRect(x0Int, height - dpr, xnInt, height - dpr)
            }
        }
    }

    const modifier: Option<RegionModifyStrategies> = tracks.currentRegionModifier
    const strategy = modifier.unwrapOrElse(RegionModifyStrategies.Identity)

    renderRegions(strategy.unselectedModifyStrategy(), true, !strategy.showOrigin())
    renderRegions(strategy.selectedModifyStrategy(), false, false)
}
