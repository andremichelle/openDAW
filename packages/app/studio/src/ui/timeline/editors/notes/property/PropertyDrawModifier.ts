import {clamp, Notifier, Observer, Option, Selection, Terminable, unitValue, ValueAxis} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {Line, NoteModifyStrategy} from "../NoteModifyStrategies.ts"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {EventCollection, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {
    NotePropertyCent,
    NotePropertyChance,
    NotePropertyVelocity,
    PropertyAccessor
} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UINoteEvent} from "@/ui/timeline/editors/notes/UINoteEvent.ts"
import {Dragging} from "@opendaw/lib-dom"

type Construct = Readonly<{
    editing: BoxEditing
    element: Element
    property: PropertyAccessor
    selection: Selection<NoteEventBoxAdapter>
    snapping: Snapping
    valueAxis: ValueAxis
    reader: NoteEventOwnerReader
}>

export class PropertyDrawModifier implements NoteModifier, NoteModifyStrategy {
    static create(construct: Construct): PropertyDrawModifier {
        return new PropertyDrawModifier(construct)
    }

    readonly #editing: BoxEditing
    readonly #element: Element
    readonly #property: PropertyAccessor
    readonly #selection: Selection<NoteEventBoxAdapter>
    readonly #snapping: Snapping
    readonly #valueAxis: ValueAxis
    readonly #reader: NoteEventOwnerReader

    readonly #notifier: Notifier<void>
    readonly #values: Map<ppqn, unitValue>

    #lastUnit: ppqn = NaN

    private constructor({editing, element, property, selection, snapping, valueAxis, reader}: Construct) {
        this.#editing = editing
        this.#element = element
        this.#property = property
        this.#selection = selection
        this.#snapping = snapping
        this.#valueAxis = valueAxis
        this.#reader = reader

        this.#notifier = new Notifier<void>()
        this.#values = new Map<ppqn, unitValue>()
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    get property(): PropertyAccessor {return this.#property}

    showOrigin(): boolean {return false}
    showCreation(): Option<UINoteEvent> {return Option.None}
    showPropertyLine(): Option<Line> {return Option.None}
    readContentDuration(owner: NoteEventOwnerReader): number {return owner.contentDuration}
    selectedModifyStrategy(): NoteModifyStrategy {return this}
    unselectedModifyStrategy(): NoteModifyStrategy {return this}

    readPosition(adapter: NoteEventBoxAdapter): ppqn {return adapter.position}
    readComplete(adapter: NoteEventBoxAdapter): ppqn {return adapter.complete}
    readPitch(adapter: NoteEventBoxAdapter): number {return adapter.pitch}
    readVelocity(adapter: NoteEventBoxAdapter): unitValue {return this.#modifyProperty(NotePropertyVelocity, adapter)}
    readCent(adapter: NoteEventBoxAdapter): number {return this.#modifyProperty(NotePropertyCent, adapter)}
    readChance(adapter: NoteEventBoxAdapter): number {return this.#modifyProperty(NotePropertyChance, adapter)}
    iterateRange<R extends NoteEvent>(owners: EventCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return owners.iterateRange(from, to)
    }

    #modifyProperty(propertyAccessor: PropertyAccessor, event: UINoteEvent): number {
        const fallbackValue = propertyAccessor.readRawValue(event)
        const emptySelection = this.#selection.isEmpty()
        if (!emptySelection && !event.isSelected) {
            return fallbackValue
        }
        if (propertyAccessor === this.#property) {
            return this.#values.get(event.position) ?? fallbackValue
        } else {
            return fallbackValue // case other property
        }
    }

    update(event: Dragging.Event): void {
        const {clientX, clientY} = event
        const {left, top} = this.#element.getBoundingClientRect()
        const u = this.#snapping.xToUnitRound(clientX - left) - this.#reader.offset
        if (this.#lastUnit !== u) {
            this.#lastUnit = u
            this.#values.set(u, clamp(this.#valueAxis.axisToValue(clientY - top), 0.0, 1.0))
            this.#dispatchChange()
        }
    }

    approve(): void {
        const result: ReadonlyArray<{ adapter: NoteEventBoxAdapter, value: number }> =
            this.#reader.content.events.asArray()
                .map(adapter => ({adapter, value: this.#modifyProperty(this.#property, adapter)}))
        this.#editing.modify(() => result.forEach(({adapter: {box}, value}) =>
            this.#property.writeValue(box, value)))
    }

    cancel(): void {
        this.#values.clear()
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}