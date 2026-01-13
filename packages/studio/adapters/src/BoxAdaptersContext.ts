import {Terminable} from "@moises-ai/lib-std"
import {BoxGraph} from "@moises-ai/lib-box"
import {LiveStreamBroadcaster, LiveStreamReceiver} from "@moises-ai/lib-fusion"
import {RootBoxAdapter} from "./RootBoxAdapter"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"
import {ClipSequencing} from "./ClipSequencing"
import {ParameterFieldAdapters} from "./ParameterFieldAdapters"
import {BoxAdapters} from "./BoxAdapters"
import {SampleLoaderManager} from "./sample/SampleLoaderManager"
import {SoundfontLoaderManager} from "./soundfont/SoundfontLoaderManager"
import {TempoMap} from "@moises-ai/lib-dsp"

export interface BoxAdaptersContext extends Terminable {
    get boxGraph(): BoxGraph
    get boxAdapters(): BoxAdapters
    get sampleManager(): SampleLoaderManager
    get soundfontManager(): SoundfontLoaderManager
    get rootBoxAdapter(): RootBoxAdapter
    get timelineBoxAdapter(): TimelineBoxAdapter
    get liveStreamReceiver(): LiveStreamReceiver
    get liveStreamBroadcaster(): LiveStreamBroadcaster
    get clipSequencing(): ClipSequencing
    get parameterFieldAdapters(): ParameterFieldAdapters
    get tempoMap(): TempoMap
    get isMainThread(): boolean
    get isAudioContext(): boolean
}