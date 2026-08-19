import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement} from "@opendaw/lib-jsx"
import {AudioUnitTrackHeader} from "@/ui/timeline/tracks/audio-unit/headers/AudioUnitTrackHeader.tsx"
import {TrackClassName} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"
import {AudioUnitBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {ClipLane} from "@/ui/timeline/tracks/audio-unit/clips/ClipLane.tsx"
import {RegionLane} from "@/ui/timeline/tracks/audio-unit/regions/RegionLane.tsx"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    audioUnitBoxAdapter: AudioUnitBoxAdapter
    trackBoxAdapter: TrackBoxAdapter
    unitHead: DefaultObservableValue<boolean>
}

export const Track = ({lifecycle, service, trackManager, audioUnitBoxAdapter, trackBoxAdapter, unitHead}: Construct) => {
    const element: HTMLElement = (
        <div className={TrackClassName}>
            <AudioUnitTrackHeader lifecycle={lifecycle}
                         service={service}
                         trackManager={trackManager}
                         audioUnitBoxAdapter={audioUnitBoxAdapter}
                         trackBoxAdapter={trackBoxAdapter}
                         unitHead={unitHead}/>
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