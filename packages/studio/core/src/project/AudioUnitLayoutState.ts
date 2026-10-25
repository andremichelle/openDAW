import {AudioUnitLayout} from "@opendaw/studio-adapters"
import {AudioBusBox, AudioUnitBox} from "@opendaw/studio-boxes"
import {DefaultObservableValue, Terminable, Terminator} from "@opendaw/lib-std"
import type {Project} from "./Project"

/** Rebuild only after a transaction changes channel layout. */
export class AudioUnitLayoutState implements Terminable {
    readonly value: DefaultObservableValue<AudioUnitLayout>
    readonly #lifecycle: Terminator
    readonly #units: Map<AudioUnitBox, Terminator>
    readonly #buses: Map<AudioBusBox, Terminator>
    #initializing = true
    #dirty = false
    #transactionActive = false
    #terminated = false
    constructor(readonly project: Project) {
        this.value = new DefaultObservableValue(new AudioUnitLayout(project.rootBox))
        this.#lifecycle = new Terminator()
        this.#units = new Map()
        this.#buses = new Map()
        this.#transactionActive = project.boxGraph.inTransaction()
        this.#lifecycle.own(project.boxGraph.subscribeTransaction({
            onBeginTransaction: () => {this.#transactionActive = true},
            onEndTransaction: () => {
                this.#transactionActive = false
                this.#publish()
            }
        }))
        this.#lifecycle.own(project.rootBoxAdapter.audioUnits.catchupAndSubscribe({
            onAdd: adapter => {
                const lifecycle = new Terminator()
                this.#units.set(adapter.box, lifecycle)
                lifecycle.ownAll(
                    adapter.box.output.subscribe(() => this.#invalidate()),
                    adapter.box.groupCollapsed.subscribe(() => this.#invalidate()),
                    adapter.box.isGroup.subscribe(() => this.#invalidate())
                )
                this.#invalidate()
            },
            onRemove: adapter => {
                this.#units.get(adapter.box)?.terminate()
                this.#units.delete(adapter.box)
                this.#invalidate()
            },
            onReorder: () => this.#invalidate()
        }))
        this.#lifecycle.own(project.rootBoxAdapter.audioBusses.catchupAndSubscribe({
            onAdd: adapter => {
                const lifecycle = new Terminator()
                this.#buses.set(adapter.box, lifecycle)
                lifecycle.own(adapter.box.output.subscribe(() => this.#invalidate()))
                this.#invalidate()
            },
            onRemove: adapter => {
                this.#buses.get(adapter.box)?.terminate()
                this.#buses.delete(adapter.box)
                this.#invalidate()
            }
        }))
        this.#initializing = false
        this.#invalidate()
    }
    get snapshot(): AudioUnitLayout {return this.value.getValue()}
    #invalidate(): void {
        if (this.#initializing || this.#terminated) {return}
        this.#dirty = true
        if (!this.#transactionActive) {this.#publish()}
    }
    #publish(): void {
        if (!this.#dirty || this.#initializing || this.#terminated) {return}
        this.#dirty = false
        this.value.setValue(new AudioUnitLayout(this.project.rootBox))
    }
    terminate(): void {
        this.#terminated = true
        this.#lifecycle.terminate()
        this.#units.forEach(lifecycle => lifecycle.terminate())
        this.#units.clear()
        this.#buses.forEach(lifecycle => lifecycle.terminate())
        this.#buses.clear()
        this.value.terminate()
    }
}
