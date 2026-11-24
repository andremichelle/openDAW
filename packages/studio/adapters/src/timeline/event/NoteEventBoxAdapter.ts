import {NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {
    Arrays,
    bipolar,
    Cache,
    float,
    int,
    isDefined,
    Option,
    Selectable,
    Terminator,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {NoteEventBox, NoteEventGroupBox} from "@opendaw/studio-boxes"
import {Address, Field, Propagation, Update} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {BoxAdapter} from "../../BoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {NoteEventCollectionBoxAdapter} from "../collection/NoteEventCollectionBoxAdapter"
import {NoteEventFeatures} from "./NoteEventFeatures"

type CopyToParams = {
    position?: ppqn,
    duration?: ppqn,
    pitch?: int,
    playCount?: int,
    playCurve?: bipolar,
    velocity?: unitValue,
    split?: boolean,
    groups?: NoteEventFeatures.GroupMapping,
    events?: Field<Pointers.NoteEvents>
}

export class NoteEventBoxAdapter implements NoteEvent, BoxAdapter, Selectable {
    readonly type = "note-event"

    readonly #context: BoxAdaptersContext
    readonly #box: NoteEventBox
    readonly #terminator: Terminator
    readonly #featureWatch: Terminator
    readonly #features: Cache<NoteEventFeatures.Values>

    #isSelected: boolean = false

    constructor(context: BoxAdaptersContext, box: NoteEventBox) {
        this.#context = context
        this.#box = box
        this.#terminator = new Terminator()
        this.#featureWatch = this.#terminator.own(new Terminator())
        this.#features = this.#terminator.own(new Cache(() => NoteEventFeatures.read(this.#box)))
        const watcher = {onAdded: () => this.#watchFeatures(true), onRemoved: () => this.#watchFeatures(true)}
        this.#terminator.ownAll(
            this.#box.random.pointerHub.subscribe(watcher),
            this.#box.split.pointerHub.subscribe(watcher))
        this.#watchFeatures(false)
        this.#terminator.own(this.#box.group.subscribe(() => this.#watchFeatures(true)))
        this.#terminator.own(this.#box.subscribe(Propagation.Children, (update: Update) => {
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
        }))
    }

    onSelected(): void {
        this.#isSelected = true
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }
    onDeselected(): void {
        this.#isSelected = false
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }

    terminate(): void {this.#terminator.terminate()}

    #watchFeatures(notify: boolean): void {
        this.#featureWatch.terminate()
        const changed = () => {
            this.#features.invalidate()
            this.collection.ifSome(collection => collection.onEventPropertyChanged())
        }
        NoteEventFeatures.chanceBox(this.#box).ifSome(chance => this.#featureWatch.own(
            chance.subscribe(Propagation.Children, changed)))
        NoteEventFeatures.groupBox(this.#box).ifSome(group => this.#featureWatch.own(
            group.subscribe(Propagation.Children, changed)))
        NoteEventFeatures.repeatBox(this.#box).ifSome(repeat => this.#featureWatch.own(
            repeat.subscribe(Propagation.Children, changed)))
        if (notify) {changed()} else {this.#features.invalidate()}
    }

    get box(): NoteEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): ppqn {return this.#box.position.getValue()}
    get duration(): ppqn {return this.#box.duration.getValue()}
    get complete(): int {return this.position + this.duration}
    get velocity(): float {return this.#box.velocity.getValue()} // 0.0...1.0
    get pitch(): int {return this.#box.pitch.getValue()} // 0...127
    get cent(): number {return this.#box.cent.getValue()} // -50.0...+50.0
    get chance(): int {return this.#features.get().chance}
    get group(): Option<NoteEventGroupBox> {return this.#features.get().group}
    get playCount(): int {return this.#features.get().playCount}
    get playCurve(): bipolar {return this.#features.get().playCurve}
    get repeatLength(): unitValue {return this.#features.get().repeatLength}
    get velocityFade(): bipolar {return this.#features.get().velocityFade}
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
        const copy = NoteEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(options?.position ?? this.position)
            box.duration.setValue(options?.duration ?? this.duration)
            box.pitch.setValue(options?.pitch ?? this.pitch)
            box.events.refer(options?.events ?? this.collection.unwrap("collection").box.events)
            box.velocity.setValue(options?.velocity ?? this.velocity)
            box.cent.setValue(this.cent)
        })
        NoteEventFeatures.copy(this.#box, copy, {
            split: options?.split ?? true,
            groups: options?.groups ?? NoteEventFeatures.createGroupMapping()
        })
        if (isDefined(options?.playCount)) {NoteEventFeatures.writePlayCount(copy, options.playCount)}
        if (isDefined(options?.playCurve)) {NoteEventFeatures.writePlayCurve(copy, options.playCurve)}
        return this.#context.boxAdapters.adapterFor(copy, NoteEventBoxAdapter)
    }

    computeCurveValue(ratio: unitValue): unitValue {return NoteEvent.curveFunc(ratio, this.playCurve)}
    canConsolidate(): boolean {return this.playCount > 1}
    consolidate(): ReadonlyArray<NoteEventBoxAdapter> {
        const {playCount, repeatLength, velocityFade} = this
        const groups = NoteEventFeatures.createGroupMapping()
        this.group.ifSome(group => groups.add({source: group.address.uuid, target: group}))
        const events = this.collection.unwrap("collection").box.events
        const adapters = Arrays.create((index) => {
            const a = Math.floor(this.computeCurveValue(index / playCount) * this.duration)
            const b = Math.floor(this.computeCurveValue((index + 1) / playCount) * this.duration)
            return this.copyTo({
                position: Math.floor(this.position + a),
                duration: Math.max(1, Math.floor((b - a) * repeatLength)),
                velocity: this.velocity * NoteEventFeatures.velocityGain(velocityFade, index, playCount),
                split: false,
                groups,
                events
            })
        }, playCount)
        this.#box.delete()
        return adapters
    }
}