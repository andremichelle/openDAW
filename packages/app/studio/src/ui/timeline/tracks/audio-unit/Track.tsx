import css from "./Track.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService.ts"
import {createElement} from "@moises-ai/lib-jsx"
import {TrackHeader} from "@/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx"
import {AudioUnitBoxAdapter, TrackBoxAdapter} from "@moises-ai/studio-adapters"
import {ClipLane} from "@/ui/timeline/tracks/audio-unit/clips/ClipLane.tsx"
import {RegionLane} from "@/ui/timeline/tracks/audio-unit/regions/RegionLane.tsx"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

const className = Html.adoptStyleSheet(css, "Track")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    audioUnitBoxAdapter: AudioUnitBoxAdapter
    trackBoxAdapter: TrackBoxAdapter
}

export const Track = ({lifecycle, service, trackManager, audioUnitBoxAdapter, trackBoxAdapter}: Construct) => {
    const element: HTMLElement = (
        <div className={className}>
            <TrackHeader lifecycle={lifecycle}
                         service={service}
                         audioUnitBoxAdapter={audioUnitBoxAdapter}
                         trackBoxAdapter={trackBoxAdapter}/>
            <ClipLane lifecycle={lifecycle}
                      service={service}
                      adapter={trackBoxAdapter}
                      trackManager={trackManager}/>
            <RegionLane lifecycle={lifecycle}
                        adapter={trackBoxAdapter}
                        trackManager={trackManager}
                        range={service.timeline.range}/>
        </div>
    )
    const {indexField, box: {enabled}} = trackBoxAdapter
    lifecycle.ownAll(
        indexField.catchupAndSubscribe(owner => element.style.gridRow = String(owner.getValue() + 1)),
        enabled.catchupAndSubscribe(owner => element.classList.toggle("mute", !owner.getValue()))
    )
    return element
}