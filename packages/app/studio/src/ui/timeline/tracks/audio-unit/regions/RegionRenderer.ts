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
import {TimelineLabels} from "@/ui/timeline/TimelineLabels"

export namespace RegionRenderer {
    let audioRenderStrategy: AudioRenderer.Strategy = AudioRenderer.DefaultStrategy

    // noinspection JSUnusedGlobalSymbols
    export const setAudioRenderStrategy = (strategy: AudioRenderer.Strategy): void => {audioRenderStrategy = strategy}

    export const render = (context: CanvasRenderingContext2D,
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
        const cssLabelHeight = RegionLabel.labelHeight()
        const fontSize = RegionLabel.fontSize() * dpr
        const labelHeight = cssLabelHeight * dpr
        const bound: RegionBound = {top: cssLabelHeight + 1, bottom: canvas.clientHeight}

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
                const x0Raw = Math.floor(range.unitToX(Math.max(position, unitMin))) * dpr
                const x1Int = Math.max(Math.floor(range.unitToX(Math.min(complete, unitMax))) * dpr, x0Raw + dpr)
                // start one pixel late to let the grid line through
                const x0Int = x1Int - x0Raw < 2 * dpr ? x0Raw : x0Raw + dpr
                const xnInt = x1Int - x0Int
                const selected = region.isSelected && !filterSelected
                const {labelColor, labelBackground, contentColor, contentBackground, loopStrokeColor} =
                    RegionPaintBucket.create(region, selected, trackDisabled)
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
                const text = TimelineLabels.forRegion(region)
                context.fillText(Context2d.truncateText(context, text, maxTextWidth).text, x0Int + 3 * dpr, 1 + labelHeight / 2)
                if (region.hasCollection) {
                    const loops = Array.from(LoopableRegion.locateLoops({
                        position, complete,
                        loopOffset: strategy.readLoopOffset(region),
                        loopDuration: strategy.readLoopDuration(region)
                    }, unitMin, unitMax))
                    context.fillStyle = loopStrokeColor
                    loops.filter(pass => pass.index > 0).forEach(pass =>
                        context.fillRect(Math.floor(range.unitToX(pass.resultStart) * dpr), labelHeight, 1, height - labelHeight))
                    context.fillStyle = contentColor
                    context.save()
                    context.beginPath()
                    context.rect(x0Int, labelHeight, xnInt, height - labelHeight)
                    context.clip()
                    region.accept({
                        visitNoteRegionBoxAdapter: (region: NoteRegionBoxAdapter): void =>
                            region.optCollection.ifSome(collection => loops.forEach(pass =>
                                NotesRenderer.render(context, range, collection, bound, contentColor, pass))),
                        visitAudioRegionBoxAdapter: (region: AudioRegionBoxAdapter): void =>
                            region.optFile.ifSome(file => {
                                const tempoMap = region.trackBoxAdapter.unwrap("trackBoxAdapter").context.tempoMap
                                loops.forEach(pass => AudioRenderer.render(context, range, file, tempoMap,
                                    region.observableOptPlayMode, region.waveformOffset.getValue(),
                                    region.gain.getValue(), bound, contentColor, pass, true, audioRenderStrategy))
                                AudioFadingRenderer.render(context, range, region.fading, bound, position, complete, labelBackground)
                            }),
                        visitValueRegionBoxAdapter: (region: ValueRegionBoxAdapter): void => {
                            const top = bound.top * dpr
                            const bottom = bound.bottom * dpr
                            const valueToY = (value: unitValue): number => bottom + value * (top - bottom)
                            const events = region.events.unwrap("events")
                            loops.forEach(pass => {
                                const adapters = ValueEvent.iterateWindow(events,
                                    pass.resultStart - pass.rawStart, pass.resultEnd - pass.rawStart)
                                context.beginPath()
                                ValueStreamRenderer.render(context, range, adapters, valueToY, contentColor, 0.2, 0.0, pass)
                                context.stroke()
                            })
                        }
                    })
                    context.restore()
                }
                if (selected) {
                    context.fillStyle = labelBackground
                    context.fillRect(x0Int, labelHeight, dpr, height - labelHeight)
                    context.fillRect(x1Int - dpr, labelHeight, dpr, height - labelHeight)
                    context.fillRect(x0Int, height - dpr, xnInt, dpr)
                }
            }
        }

        const modifier: Option<RegionModifyStrategies> = tracks.currentRegionModifier
        const strategy = modifier.unwrapOrElse(RegionModifyStrategies.Identity)

        renderRegions(strategy.unselectedModifyStrategy(), true, !strategy.showOrigin())
        renderRegions(strategy.selectedModifyStrategy(), false, false)
    }
}