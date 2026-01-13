import {BoxGraph} from "@moises-ai/lib-box"
import {AudioPitchStretchBox, AudioTimeStretchBox, WarpMarkerBox} from "@moises-ai/studio-boxes"
import {ppqn} from "@moises-ai/lib-dsp"
import {UUID} from "@moises-ai/lib-std"
import {WarpMarkerTemplate} from "./WarpMarkerTemplate"

export namespace AudioContentHelpers {
    export const addDefaultWarpMarkers = (boxGraph: BoxGraph,
                                          playMode: AudioPitchStretchBox | AudioTimeStretchBox,
                                          durationInPPQN: ppqn,
                                          durationInSeconds: number) => {
        WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(0)
            box.seconds.setValue(0)
        })
        WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(durationInPPQN)
            box.seconds.setValue(durationInSeconds)
        })
    }

    export const addWarpMarkers = (boxGraph: BoxGraph,
                                   playMode: AudioPitchStretchBox | AudioTimeStretchBox,
                                   templates: ReadonlyArray<WarpMarkerTemplate>) => {
        templates.forEach(({position, seconds}) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(position)
            box.seconds.setValue(seconds)
        }))
    }
}