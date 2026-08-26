import {StereoCompositeBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioCompositeAdapter} from "./AudioEffectComposite/AudioCompositeAdapter"

// The stereo SPLIT composite: its factory creates exactly two entries (L / R) and the engine feeds entry 0 the
// left channel and entry 1 the right, so the entry set is FIXED — the UI offers no add / remove / reorder.
// Everything else is the shared audio-composite behaviour (see AudioCompositeAdapter).
export class StereoCompositeBoxAdapter extends AudioCompositeAdapter {
    constructor(context: BoxAdaptersContext, box: StereoCompositeBox) {
        super(context, box)
    }

    get entriesFixed(): boolean {return true}
    get manualUrl(): string {return DeviceManualUrls.StereoComposite}
}
