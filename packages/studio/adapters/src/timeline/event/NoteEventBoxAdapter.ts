import {NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {Arrays, float, int, Option, Selectable, Subscription, unitValue, UUID} from "@moises-ai/lib-std"
import {NoteEventBox} from "@moises-ai/studio-boxes"
import {Address, Field, Propagation, Update} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {BoxAdapter} from "../../BoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {NoteEventCollectionBoxAdapter} from "../collection/NoteEventCollectionBoxAdapter"

type CopyToParams = {
    position?: ppqn,
    duration?: ppqn,
    pitch?: int,
    playCount?: int,
    events?: Field<Pointers.NoteEvents>
}

export class NoteEventBoxAdapter implements NoteEvent, BoxAdapter, Selectable {
    readonly type = "note-event"

    readonly #context: BoxAdaptersContext
    readonly #box: NoteEventBox

    readonly #subscription: Subscription

    #isSelected: boolean = false

    constructor(context: BoxAdaptersContext, box: NoteEventBox) {
        this.#context = context
        this.#box = box

        this.#subscription = this.#box.subscribe(Propagation.Children, (update: Update) => {
            if (this.collection.isEmpty()) {return}
            if (update.type === "primitive" || update.type === "pointer") {
                const collection = this.collection.unwrap()
                const updatedFieldKeys = update.address.fieldKeys
                const pitchChanged = Arrays.equals(this.#box.pitch.address.fieldKeys, updatedFieldKeys)
                const positionChanged = Arrays.equals(this.#box.position.address.fieldKeys, updatedFieldKeys)
                if (pitchChanged || positionChanged) {
                    collection.requestSorting()
                } else {
                    collection.onEventPropertyChanged()
                }
            }
        })
    }

    onSelected(): void {
        this.#isSelected = true
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }
    onDeselected(): void {
        this.#isSelected = false
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }

    terminate(): void {this.#subscription.terminate()}

    get box(): NoteEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): ppqn {return this.#box.position.getValue()}
    get duration(): ppqn {return this.#box.duration.getValue()}
    get complete(): int {return this.position + this.duration}
    get velocity(): float {return this.#box.velocity.getValue()} // 0.0...1.0
    get pitch(): int {return this.#box.pitch.getValue()} // 0...127
    get cent(): number {return this.#box.cent.getValue()} // -50.0...+50.0
    get chance(): int {return this.#box.chance.getValue()} // 0...100%
    get playCount(): int {return this.#box.playCount.getValue()} // 1...16
    get playCurve(): int {return this.#box.playCurve.getValue()} // -1...+1
    get isSelected(): boolean {return this.#isSelected}
    get collection(): Option<NoteEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, NoteEventCollectionBoxAdapter))
    }
    normalizedPitch(): unitValue {
        if (this.collection.isEmpty()) {return 0.5}
        const {minPitch, maxPitch} = this.collection.unwrap()
        return minPitch === maxPitch ? 0.5 : 1.0 - (this.pitch - minPitch) / (maxPitch - minPitch)
    }

    copyAsNoteEvent(): NoteEvent {
        return {
            type: "note-event",
            position: this.position,
            duration: this.duration,
            pitch: this.pitch,
            cent: this.cent,
            velocity: this.velocity
        }
    }

    copyTo(options?: CopyToParams): NoteEventBoxAdapter {
        return this.#context.boxAdapters.adapterFor(NoteEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(options?.position ?? this.position)
            box.duration.setValue(options?.duration ?? this.duration)
            box.pitch.setValue(options?.pitch ?? this.pitch)
            box.playCount.setValue(options?.playCount ?? this.playCount)
            box.events.refer(options?.events ?? this.collection.unwrap().box.events)
            box.velocity.setValue(this.velocity)
            box.cent.setValue(this.cent)
            box.chance.setValue(this.chance)
        }), NoteEventBoxAdapter)
    }

    computeCurveValue(ratio: unitValue): unitValue {return NoteEvent.curveFunc(ratio, this.playCurve)}
    canConsolidate(): boolean {return this.playCount > 1}
    consolidate(): ReadonlyArray<NoteEventBoxAdapter> {
        const playCount = this.playCount
        const events = this.collection.unwrap().box.events
        const adapters = Arrays.create((index) => {
            const a = Math.floor(this.computeCurveValue(index / playCount) * this.duration)
            const b = Math.floor(this.computeCurveValue((index + 1) / playCount) * this.duration)
            return this.copyTo({
                position: Math.floor(this.position + a),
                duration: Math.max(1, b - a),
                playCount: 1,
                events
            })
        }, playCount)
        this.#box.delete()
        return adapters
    }
}