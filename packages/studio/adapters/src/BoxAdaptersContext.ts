import {Terminable} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {LiveStreamBroadcaster, LiveStreamReceiver} from "@opendaw/lib-fusion"
import {RootBoxAdapter} from "./RootBoxAdapter"
import {TimelineBoxAdapter} from "./timeline/TimelineBoxAdapter"
import {ClipSequencing} from "./ClipSequencing"
import {ParameterFieldAdapters} from "./ParameterFieldAdapters"
import {BoxAdapters} from "./BoxAdapters"
import {SampleLoaderManager} from "./sample/SampleLoaderManager"
import {SoundfontLoaderManager} from "./soundfont/SoundfontLoaderManager"
import {ppqn, TempoMap} from "@opendaw/lib-dsp"

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
    get signatureDuration(): ppqn
    get tempoMap(): TempoMap
    get isMainThread(): boolean
    get isAudioContext(): boolean
}