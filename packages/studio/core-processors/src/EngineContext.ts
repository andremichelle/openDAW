import {Observer, Subscription, Terminable, UUID} from "@moises-ai/lib-std"
import {Processor, ProcessPhase} from "./processing"
import {LiveStreamBroadcaster} from "@moises-ai/lib-fusion"
import {UpdateClock} from "./UpdateClock"
import {TimeInfo} from "./TimeInfo"
import {AudioUnit} from "./AudioUnit"
import {Mixer} from "./Mixer"
import {BoxAdaptersContext, EngineSettings, EngineToClient, PreferencesClient} from "@moises-ai/studio-adapters"
import {AudioOutputBufferRegistry} from "./AudioOutputBufferRegistry"

export interface EngineContext extends BoxAdaptersContext, Terminable {
    get broadcaster(): LiveStreamBroadcaster
    get updateClock(): UpdateClock
    get timeInfo(): TimeInfo
    get mixer(): Mixer
    get engineToClient(): EngineToClient
    get audioOutputBufferRegistry(): AudioOutputBufferRegistry
    get preferences(): PreferencesClient<EngineSettings>

    getAudioUnit(uuid: UUID.Bytes): AudioUnit
    registerProcessor(processor: Processor): Terminable
    registerEdge(source: Processor, target: Processor): Terminable
    subscribeProcessPhase(observer: Observer<ProcessPhase>): Subscription
    ignoresRegion(uuid: UUID.Bytes): boolean
    sendMIDIData(midiDeviceId: string, data: Uint8Array, relativeTimeInMs: number): void
}