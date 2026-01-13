import {int, Procedure, Subscription, Terminator, Unhandled} from "@moises-ai/lib-std"
import {Address, Addressable} from "./address"

export enum Propagation {This, Parent, Children}

export interface Dispatchers<TARGET extends Addressable> {
    subscribe(propagation: Propagation, address: Address, procedure: Procedure<TARGET>): Subscription
    dispatch(target: TARGET): void
    countStations(): int
}

export namespace Dispatchers {
    export const create = <TARGET extends Addressable>(): Dispatchers<TARGET> => new DispatchersImpl<TARGET>()
}

type FilterStrategy = <TARGET extends Addressable>(target: Address, sorted: ReadonlyArray<TARGET>) => Array<TARGET>

class DispatchersImpl<TARGET extends Addressable> implements Dispatchers<TARGET> {
    readonly #thisDispatcher: Dispatcher<TARGET> = new Dispatcher<TARGET>(Addressable.equals)
    readonly #parentDispatcher: Dispatcher<TARGET> = new Dispatcher<TARGET>(Addressable.startsWith)
    readonly #childrenDispatcher: Dispatcher<TARGET> = new Dispatcher<TARGET>(Addressable.endsWith)
    readonly #deferredStations: Array<DeferredMonitor<TARGET>> = []

    #order: int = 0 | 0
    #dispatching: boolean = false

    subscribe(propagation: Propagation, address: Address, procedure: Procedure<TARGET>): Subscription {
        const monitor: Monitor<TARGET> = new Monitor<TARGET>(address, propagation, this.#order++, procedure)
        if (this.#dispatching) {
            const deferred: DeferredMonitor<TARGET> = new DeferredMonitor<TARGET>(monitor, propagation)
            this.#deferredStations.push(deferred)
            return deferred
        } else {
            return this.subscribeMonitor(monitor, propagation)
        }
    }

    dispatch(target: TARGET): void {
        this.#dispatching = true
        const invoked: Array<Monitor<TARGET>> = [
            ...this.#thisDispatcher.filter(target),
            ...this.#parentDispatcher.filter(target),
            ...this.#childrenDispatcher.filter(target)]
        invoked
            .sort(({order: a}: Monitor<TARGET>, {order: b}: Monitor<TARGET>) => a - b)
            .forEach((station: Monitor<TARGET>): void => station.procedure(target))
        this.#dispatching = false
        this.#deferredStations.forEach((station: DeferredMonitor<TARGET>) => station.subscribe(this))
        this.#deferredStations.length = 0
    }

    subscribeMonitor(monitor: Monitor<TARGET>, propagation: Propagation): Subscription {
        switch (propagation) {
            case Propagation.This:
                return this.#thisDispatcher.subscribe(monitor)
            case Propagation.Parent:
                return this.#parentDispatcher.subscribe(monitor)
            case Propagation.Children:
                return this.#childrenDispatcher.subscribe(monitor)
            default:
                return Unhandled(propagation)
        }
    }

    countStations(): int {
        return this.#thisDispatcher.count() + this.#parentDispatcher.count() + this.#childrenDispatcher.count()
    }
}

class Monitor<TARGET extends Addressable> {
    constructor(
        readonly address: Address,
        readonly propagation: Propagation,
        readonly order: int,
        readonly procedure: Procedure<TARGET>) {}

    toString(): string {
        return `{ Monitor address: ${this.address}, propagation: ${Propagation[this.propagation]}, order: ${this.order} }`
    }
}

class Dispatcher<TARGET extends Addressable> {
    readonly #monitors: Array<Monitor<TARGET>> = []

    #sorted: boolean = true

    constructor(readonly filterStrategy: FilterStrategy) {}

    subscribe(monitor: Monitor<TARGET>): Subscription {
        this.#monitors.push(monitor)
        this.#sorted = this.#monitors.length < 2
        return {
            terminate: (): void => {
                let index: int = this.#monitors.length
                while (--index >= 0) {
                    if (this.#monitors[index] === monitor) {
                        this.#monitors.splice(index, 1)
                    }
                }
            }
        }
    }

    stations(): ReadonlyArray<Monitor<TARGET>> {
        if (!this.#sorted) {
            this.#monitors.sort(Addressable.Comparator)
            this.#sorted = true
        }
        return this.#monitors
    }

    filter(target: TARGET): Array<Monitor<TARGET>> {return this.filterStrategy(target.address, this.stations())}

    count(): int {return this.#monitors.length}
}

class DeferredMonitor<TARGET extends Addressable> implements Subscription {
    readonly #terminator: Terminator = new Terminator()

    #terminated: boolean = false

    constructor(readonly monitor: Monitor<TARGET>, readonly propagation: Propagation) {}

    subscribe(dispatchers: DispatchersImpl<TARGET>): void {
        if (this.#terminated) {return}
        this.#terminator.terminate()
        this.#terminator.own(dispatchers.subscribeMonitor(this.monitor, this.propagation))
    }

    terminate(): void {
        this.#terminated = true
        this.#terminator.terminate()
    }
}