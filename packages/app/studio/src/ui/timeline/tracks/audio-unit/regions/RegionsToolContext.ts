import {DefaultObservableValue, Nullable} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {ShortcutContext} from "@opendaw/lib-dom"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator.ts"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"

export type RegionsToolContext = Readonly<{
    service: StudioService
    manager: TracksManager
    scrollContainer: HTMLElement
    range: TimelineRange
    element: HTMLElement
    capturing: ElementCapturing<RegionCaptureTarget>
    regionLocator: TimelineSelectableLocator<AnyRegionBoxAdapter>
    shortcuts: ShortcutContext
    markerPosition: DefaultObservableValue<Nullable<ppqn>>
}>
