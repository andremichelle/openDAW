import {AudioUnitLayout} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {DefaultObservableValue, Terminable, Terminator} from "@opendaw/lib-std"
import type {Project} from "./Project"

/** Rebuild only after a transaction changes channel layout. */
export class AudioUnitLayoutState implements Terminable {
    readonly value: DefaultObservableValue<AudioUnitLayout>
    readonly #lifecycle: Terminator
    readonly #units: Map<AudioUnitBox, Terminator>
    #initializing = true
    #queued = false
    #terminated = false
    constructor(readonly project: Project) {
        this.value = new DefaultObservableValue(new AudioUnitLayout(project.rootBox))
        this.#lifecycle = new Terminator()
        this.#units = new Map()
        this.#lifecycle.own(project.rootBoxAdapter.audioUnits.catchupAndSubscribe({
            onAdd: adapter => {
                const lifecycle = new Terminator()
                this.#units.set(adapter.box, lifecycle)
                lifecycle.ownAll(
                    adapter.box.groupParent.subscribe(() => this.#invalidate()),
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
        this.#initializing = false
        this.#invalidate()
    }
    get snapshot(): AudioUnitLayout {return this.value.getValue()}
    #invalidate(): void {
        if (this.#initializing || this.#terminated || this.#queued) {return}
        if (this.project.boxGraph.inTransaction()) {
            this.#queued = true
            this.project.boxGraph.subscribeEndTransaction(() => {
                this.#queued = false
                if (!this.#terminated) {this.value.setValue(new AudioUnitLayout(this.project.rootBox))}
            })
        } else {
            this.value.setValue(new AudioUnitLayout(this.project.rootBox))
        }
    }
    terminate(): void {
        this.#terminated = true
        this.#lifecycle.terminate()
        this.#units.forEach(lifecycle => lifecycle.terminate())
        this.#units.clear()
        this.value.terminate()
    }
}
