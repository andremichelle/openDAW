import {int} from "@opendaw/lib-std"
import {MidSideCompositeBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {AudioCompositeAdapter} from "./AudioEffectComposite/AudioCompositeAdapter"

export class MidSideCompositeBoxAdapter extends AudioCompositeAdapter {
    constructor(context: BoxAdaptersContext, box: MidSideCompositeBox) {
        super(context, box)
    }

    get entriesFixed(): boolean {return true}
    entryLabelAt(index: int): string {return index === 0 ? "Mid" : "Side"}
    get manualUrl(): string {return DeviceManualUrls.MidSideComposite}
}
