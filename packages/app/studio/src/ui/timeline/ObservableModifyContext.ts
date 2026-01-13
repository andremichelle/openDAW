import {Notifier, Observer, Option, Subscription, Terminator} from "@moises-ai/lib-std"
import {BoxEditing} from "@moises-ai/lib-box"
import {ObservableModifier} from "@/ui/timeline/ObservableModifier.ts"
import {Dragging} from "@moises-ai/lib-dom"

export class ObservableModifyContext<MODIFIER extends ObservableModifier> {
    readonly #editing: BoxEditing
    readonly #notifier: Notifier<void>

    #modifier: Option<MODIFIER> = Option.None

    constructor(editing: BoxEditing) {
        this.#editing = editing
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
            approve: (): void => modifier.approve(this.#editing),
            cancel: (): void => modifier.cancel(),
            finally: (): void => lifeTime.terminate()
        })
    }
}