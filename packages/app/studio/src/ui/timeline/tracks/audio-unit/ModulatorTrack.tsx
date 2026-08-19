import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorTrackHeader} from "@/ui/timeline/tracks/audio-unit/headers/ModulatorTrackHeader.tsx"
import {ClipLane} from "@/ui/timeline/tracks/audio-unit/clips/ClipLane.tsx"
import {RegionLane} from "@/ui/timeline/tracks/audio-unit/regions/RegionLane.tsx"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {trackClassName} from "@/ui/timeline/tracks/audio-unit/Track.tsx"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    trackBoxAdapter: TrackBoxAdapter
}

export const ModulatorTrack = ({lifecycle, service, trackManager, trackBoxAdapter}: Construct) => {
    const element: HTMLElement = (
        <div className={trackClassName}>
            <ModulatorTrackHeader lifecycle={lifecycle} service={service} trackBoxAdapter={trackBoxAdapter}/>
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
    const {box: {enabled}} = trackBoxAdapter
    lifecycle.own(enabled.catchupAndSubscribe(owner => element.classList.toggle("mute", !owner.getValue())))
    return element
}
