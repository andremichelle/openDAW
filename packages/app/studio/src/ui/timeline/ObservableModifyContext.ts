import {Notifier, Observer, Option, Subscription, Terminator} from "@opendaw/lib-std"
import {ObservableModifier} from "@/ui/timeline/ObservableModifier.ts"
import {Dragging} from "@opendaw/lib-dom"

export class ObservableModifyContext<MODIFIER extends ObservableModifier> {
    readonly #notifier: Notifier<void>

    #modifier: Option<MODIFIER> = Option.None

    constructor() {
        this.#notifier = new Notifier<void>()
    }

    get modifier(): Option<MODIFIER> {return this.#modifier}

    subscribeUpdate(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    startModifier(modifier: MODIFIER): Option<Dragging.Process> {
        const lifeTime = new Terminator()
        lifeTime.own(modifier.subscribeUpdate(() => this.#notifier.notify()))
        lifeTime.own({terminate: () => {
            this.#modifier = Option.None
            this.#notifier.notify()
        }})
        this.#modifier = Option.wrap(modifier)
        return Option.wrap({
            update: (event: Dragging.Event): void => modifier.update(event),
            approve: (): void => modifier.approve(),
            cancel: (): void => modifier.cancel(),
            finally: (): void => lifeTime.terminate()
        })
    }
}