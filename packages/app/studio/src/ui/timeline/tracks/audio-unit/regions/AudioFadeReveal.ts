import {clamp, Notifier, ObservableOption, Observer, Option, Subscription, Terminable, Terminator, unitValue} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"

// How visible the fade handles of an audio region are: they fade in when it gets hovered and out when it is left.
export class AudioFadeReveal implements Terminable {
    static readonly DurationInMs = 150.0

    readonly #terminator: Terminator
    readonly #notifier: Notifier<AudioRegionBoxAdapter>
    readonly #opacities: Map<AudioRegionBoxAdapter, unitValue>

    #hovered: Option<AudioRegionBoxAdapter> = Option.None
    #running: Option<Terminable> = Option.None

    constructor(hovered: ObservableOption<AudioRegionBoxAdapter>) {
        this.#terminator = new Terminator()
        this.#notifier = this.#terminator.own(new Notifier<AudioRegionBoxAdapter>())
        this.#opacities = new Map()
        this.#terminator.ownAll(
            hovered.subscribe(option => this.hover(Option.wrap(option.unwrapOrNull()))),
            {terminate: () => this.#stop()}
        )
    }

    opacityOf(region: AudioRegionBoxAdapter): unitValue {return this.#opacities.get(region) ?? 0.0}

    // told about every region whose opacity moved
    subscribe(observer: Observer<AudioRegionBoxAdapter>): Subscription {return this.#notifier.subscribe(observer)}

    hover(region: Option<AudioRegionBoxAdapter>): void {
        this.#hovered = region
        region.ifSome(hovered => {if (!this.#opacities.has(hovered)) {this.#opacities.set(hovered, 0.0)}})
        if (this.#running.isEmpty() && !this.#isSettled()) {
            let last = performance.now()
            this.#running = Option.wrap(AnimationFrame.add(() => {
                const now = performance.now()
                this.advance(now - last)
                last = now
            }))
        }
    }

    advance(elapsedInMs: number): void {
        const step = elapsedInMs / AudioFadeReveal.DurationInMs
        for (const [region, opacity] of Array.from(this.#opacities)) {
            const next = clamp(opacity + (this.#hovered.contains(region) ? step : -step), 0.0, 1.0)
            if (next === opacity) {continue}
            if (next === 0.0) {this.#opacities.delete(region)} else {this.#opacities.set(region, next)}
            this.#notifier.notify(region)
        }
        if (this.#isSettled()) {this.#stop()}
    }

    terminate(): void {this.#terminator.terminate()}

    #isSettled(): boolean {
        for (const [region, opacity] of this.#opacities) {
            if (opacity !== (this.#hovered.contains(region) ? 1.0 : 0.0)) {return false}
        }
        return true
    }

    #stop(): void {
        this.#running.ifSome(running => running.terminate())
        this.#running = Option.None
    }
}
