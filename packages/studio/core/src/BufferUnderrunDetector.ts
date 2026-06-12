import {int, RuntimeNotifier, Terminable, Terminator} from "@opendaw/lib-std"
import {Runtime} from "@opendaw/lib-runtime"
import {EngineFacade} from "./EngineFacade"
import {StudioPreferences} from "./StudioPreferences"

export class BufferUnderrunDetector implements Terminable {
    static readonly CONSECUTIVE_THRESHOLD: int = 3

    readonly #terminator = new Terminator()
    readonly #pollLifecycle: Terminator
    readonly #playbackStats: AudioPlaybackStats
    readonly #engine: EngineFacade

    #lastValue: int = 0
    #consecutiveIncreases: int = 0

    constructor(playbackStats: AudioPlaybackStats, engine: EngineFacade) {
        this.#playbackStats = playbackStats
        this.#engine = engine
        this.#pollLifecycle = this.#terminator.own(new Terminator())
        this.#terminator.own(engine.isPlaying.catchupAndSubscribe(owner =>
            owner.getValue() ? this.#startPolling() : this.#stopPolling()))
    }

    #startPolling(): void {
        this.#pollLifecycle.terminate()
        this.#lastValue = this.#playbackStats.underrunEvents
        this.#consecutiveIncreases = 0
        this.#pollLifecycle.own(Runtime.scheduleInterval(() => this.#poll(), 1000))
    }

    #stopPolling(): void {this.#pollLifecycle.terminate()}

    #poll(): void {
        const events = this.#playbackStats.underrunEvents
        this.#consecutiveIncreases = events > this.#lastValue ? this.#consecutiveIncreases + 1 : 0
        this.#lastValue = events
        if (this.#consecutiveIncreases >= BufferUnderrunDetector.CONSECUTIVE_THRESHOLD) {
            this.#consecutiveIncreases = 0
            this.#handleOverload()
        }
    }

    #handleOverload(): void {
        if (!StudioPreferences.settings.engine["stop-playback-when-overloading"]) {return}
        this.#stopPolling()
        this.#engine.sleep()
        RuntimeNotifier.notify({message: "Audio dropout. Playback stopped.", icon: "Info"})
    }

    terminate(): void {this.#terminator.terminate()}
}