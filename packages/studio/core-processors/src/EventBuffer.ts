import {ArrayMultimap, int} from "@moises-ai/lib-std"
import {Event} from "@moises-ai/lib-dsp"

export class EventBuffer {
    readonly #events: ArrayMultimap<int, Event>

    constructor() {this.#events = new ArrayMultimap()}

    add(index: int, event: Event): void {this.#events.add(index, event)}
    get(index: int): ReadonlyArray<Event> {return this.#events.get(index)}
    forEach(procedure: (index: int, values: ReadonlyArray<Event>) => void): void {return this.#events.forEach(procedure)}
    clear(): void {this.#events.clear()}
}