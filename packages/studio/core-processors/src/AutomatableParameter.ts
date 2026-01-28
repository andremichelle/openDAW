import {Address, PrimitiveValues} from "@moises-ai/lib-box"
import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {
    assert,
    Notifier,
    Observer,
    Option,
    Subscription,
    Terminable,
    TerminableOwner,
    Terminator,
    unitValue
} from "@moises-ai/lib-std"
import {ppqn} from "@moises-ai/lib-dsp"
import {EngineContext} from "./EngineContext"

export class AutomatableParameter<T extends PrimitiveValues = any> implements TerminableOwner, Terminable {
    readonly #terminator = new Terminator()

    readonly #context: EngineContext
    readonly #adapter: AutomatableParameterFieldAdapter<T>
    readonly #notifier: Notifier<this>

    #broadcasting: Option<Subscription> = Option.None

    #value: T

    constructor(context: EngineContext, adapter: AutomatableParameterFieldAdapter<T>) {
        this.#context = context
        this.#adapter = adapter
        this.#notifier = new Notifier<this>()
        this.#value = this.#adapter.getValue()
        this.#terminator.own(this.#adapter.subscribe(owner => {
            this.#value = owner.getValue()
            this.#notifier.notify(this)
        }))
    }

    get adapter(): AutomatableParameterFieldAdapter<T> {return this.#adapter}
    get address(): Address {return this.#adapter.address}

    subscribe(observer: Observer<this>): Subscription {return this.#notifier.subscribe(observer)}
    getValue(): T {return this.#value}
    getUnitValue(): unitValue {return this.#adapter.valueMapping.x(this.#value)}

    onStartAutomation(): void {
        assert(this.#broadcasting.isEmpty(), "Already broadcasting")
        this.#broadcasting = Option.wrap(this.#context.broadcaster
            .broadcastFloat(this.#adapter.address, () => this.getUnitValue()))
    }

    updateAutomation(position: ppqn): boolean {
        const value = this.#adapter.valueAt(position)
        if (this.#value !== value) {
            this.#value = value
            return true
        }
        return false
    }

    onStopAutomation(): void {
        assert(this.#broadcasting.nonEmpty(), "Never started broadcasting")
        this.#broadcasting.unwrap().terminate()
        this.#broadcasting = Option.None
        this.#value = this.#adapter.getValue()
        this.#notifier.notify(this)
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own<T>(terminable)}
    ownAll<T extends Terminable>(...terminables: T[]): void {this.#terminator.ownAll<T>(...terminables)}
    spawn(): Terminator {return this.#terminator.spawn()}
    terminate(): void {this.#terminator.terminate()}
}