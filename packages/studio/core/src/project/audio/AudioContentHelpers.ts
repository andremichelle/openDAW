import {BoxGraph} from "@opendaw/lib-box"
import {AudioPitchStretchBox, AudioTimeStretchBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ppqn, seconds} from "@opendaw/lib-dsp"
import {panic, UUID} from "@opendaw/lib-std"
import {WarpMarkerTemplate} from "./WarpMarkerTemplate"

export namespace AudioContentHelpers {
    export const addDefaultWarpMarkers = (boxGraph: BoxGraph,
                                          playMode: AudioPitchStretchBox | AudioTimeStretchBox,
                                          durationInPPQN: ppqn,
                                          durationInSeconds: seconds) => {
        if (durationInPPQN <= 0 || durationInSeconds <= 0) {
            return panic(`addDefaultWarpMarkers requires positive duration: `
                + `durationInPPQN=${durationInPPQN}, durationInSeconds=${durationInSeconds}`)
        }
        WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(0)
            box.seconds.setValue(0.0)
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