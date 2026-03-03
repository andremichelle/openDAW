import css from "./RegionBound.sass?inline"
import {Lifecycle, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"
import {LoopableRegion} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, RegionAdapters, UnionBoxTypes} from "@opendaw/studio-adapters"
import {createRegionCapturing} from "@/ui/timeline/editors/RegionCapturingTarget.ts"
import {installCursor} from "@/ui/hooks/cursor.ts"
import {Context2d, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "RegionBound")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    range: TimelineRange
}

export const RegionBound = ({lifecycle, service, range}: Construct) => {
    const regionSubscriber = lifecycle.own(new Terminator())
    const editingRegion = service.project.userEditingManager.timeline
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
        for (const region of editingRegion.trackBoxAdapter.unwrap().regions.collection.iterateRange(unitMin, unitMax)) {
            for (const pass of LoopableRegion.locateLoops(region, unitMin, unitMax)) {
                const x0 = Math.floor((range.unitToX(pass.resultStart) + 1) * devicePixelRatio)
                const x1 = Math.floor(range.unitToX(pass.resultEnd) * devicePixelRatio)
                if (pass.index === 0) {
                    context.fillStyle = `hsla(${region.hue}, 60%, 30%, 0.5)`
                    context.fillRect(x0, 0, x1 - x0, height * devicePixelRatio)
                } else {
                    context.fillStyle = `hsla(${region.hue}, 60%, 30%, 0.25)`
                    context.fillRect(x0, 0, x1 - x0, height * devicePixelRatio)
                }
            }
            const x0 = Math.floor((range.unitToX(region.position) + 3) * devicePixelRatio)
            const x1 = Math.floor((range.unitToX(region.offset + Math.min(region.duration, region.loopDuration)) - 1) * devicePixelRatio)
            context.fillStyle = `hsl(${region.hue}, 60%, 60%)`
            const {text} = Context2d.truncateText(context, region.label, x1 - x0)
            context.fillText(text, x0, height * devicePixelRatio / 2.0 + 1)
        }

        const x0 = Math.floor((range.unitToX(editingRegion.position) + 1.5) * devicePixelRatio)
        const x1 = Math.floor((range.unitToX(
            Math.min(editingRegion.offset + editingRegion.loopDuration, editingRegion.complete)) - 0.5) * devicePixelRatio)
        context.strokeStyle = `hsl(${editingRegion.hue}, 60%, 30%)`
        context.lineWidth = devicePixelRatio
        context.strokeRect(x0, 1, x1 - x0, (height - 1) * devicePixelRatio)
    }))

    const listenToRegion = (region: AnyRegionBoxAdapter): Terminable => {
        return Terminable.many(
            region.trackBoxAdapter.unwrap().regions.subscribeChanges(requestUpdate),
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
        installCursor(canvas, capturing, {
            get: (_target) => null/* TODO{
				if (target === null) {return null}
				switch (target.type) {
					case "region-position":
						return "move"
					case "region-start":
						return "w-resize"
					case "region-complete":
						return "e-resize"
					case "loop-duration":
						return Cursor.ExpandWidth
					default:
						return panic()
				}
			}*/
        })
    )
    return (
        <div className={className}>
            {canvas}
        </div>
    )
}