import {AudioEffectCompositeBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioCompositeAdapter} from "./AudioEffectComposite/AudioCompositeAdapter"

// The parallel FX composite: the user builds the entry list, so entries are add / remove / reorder-able. Its
// input is BROADCAST to every entry (see AudioCompositeAdapter for the shared behaviour).
export class AudioEffectCompositeBoxAdapter extends AudioCompositeAdapter {
    constructor(context: BoxAdaptersContext, box: AudioEffectCompositeBox) {
        super(context, box)
    }

    get entriesFixed(): boolean {return false}
    get manualUrl(): string {return DeviceManualUrls.AudioEffectComposite}
}
