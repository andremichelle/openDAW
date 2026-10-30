import {asInstanceOf} from "@opendaw/lib-std"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, EngineSettings, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"

export namespace TakePolicy {
    export type Take = { readonly trackBox: TrackBox, readonly regionBox: AnyRegionBox }

    // a completed take silences the older takes the way the recording preferences ask for
    export const applyOlderTakeAction = ({olderTakeAction, olderTakeScope}: EngineSettings["recording"],
                                         audioUnitBox: AudioUnitBox, {trackBox, regionBox}: Take): void => {
        if (olderTakeScope === "none") {return}
        if (olderTakeScope === "all") {
            for (const track of audioUnitBox.tracks.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, TrackBox))) {
                const trackType = track.type.getValue()
                if (trackType === TrackType.Value) {continue}
                if (track === trackBox) {continue}
                if (olderTakeAction === "disable-track") {
                    if (track.isAttached()) {
                        track.enabled.setValue(false)
                    }
                } else {
                    for (const region of track.regions.pointerHub.incoming()
                        .map(({box}) => UnionBoxTypes.asRegionBox(box))) {
                        if (region.isAttached()) {
                            region.mute.setValue(true)
                        }
                    }
                }
            }
        } else {
            if (olderTakeAction === "disable-track") {
                if (trackBox.isAttached()) {
                    trackBox.enabled.setValue(false)
                }
            } else {
                if (regionBox.isAttached()) {
                    regionBox.mute.setValue(true)
                }
            }
        }
    }
}
