import {clamp, Notifier, Observer, Option, Selection, Terminable, unitValue, ValueAxis} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {Line, NoteModifyStrategy, Point} from "../NoteModifyStrategies.ts"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {EventCollection, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {
    NotePropertyCent,
    NotePropertyChance,
    NotePropertyVelocity,
    PropertyAccessor
} from "@/ui/timeline/editors/notes/property/PropertyAccessor.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UINoteEvent} from "@/ui/timeline/editors/notes/UINoteEvent.ts"
import {Dragging} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"

type Construct = Readonly<{
    editing: BoxEditing
    element: Element
    property: PropertyAccessor
    selection: Selection<NoteEventBoxAdapter>
    range: TimelineRange
    valueAxis: ValueAxis
    lineOrigin: Readonly<Point>
    reader: NoteEventOwnerReader
}>

export class PropertyLineModifier implements NoteModifier, NoteModifyStrategy {
    static create(construct: Construct): PropertyLineModifier {
        return new PropertyLineModifier(construct)
    }

    readonly #editing: BoxEditing
    readonly #element: Element
    readonly #property: PropertyAccessor
    readonly #selection: Selection<NoteEventBoxAdapter>
    readonly #range: TimelineRange
    readonly #valueAxis: ValueAxis
    readonly #lineOrigin: Point
    readonly #lineEnd: Point
    readonly #reader: NoteEventOwnerReader

    readonly #notifier: Notifier<void>

    private constructor({editing, element, property, selection, range, valueAxis, lineOrigin, reader}: Construct) {
        this.#editing = editing
        this.#element = element
        this.#property = property
        this.#selection = selection
        this.#range = range
        this.#valueAxis = valueAxis
        this.#lineOrigin = lineOrigin
        this.#lineEnd = {...lineOrigin}
        this.#reader = reader

        this.#notifier = new Notifier<void>()
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    get property(): PropertyAccessor {return this.#property}

    showOrigin(): boolean {return false}
    showCreation(): Option<UINoteEvent> {return Option.None}
    showPropertyLine(): Option<Line> {return Option.wrap([this.#lineOrigin, this.#lineEnd])}
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
            const position = event.position + this.#reader.position
            const {u: u0, v: v0} = this.#lineOrigin
            const {u: u1, v: v1} = this.#lineEnd
            if (Math.abs(u1 - u0) < 1e-3) {return fallbackValue} // avoid division close to zero
            if (position < Math.min(u0, u1) || position > Math.max(u0, u1)) {return fallbackValue} // outside line
            return this.#property.valueMapping.y(v0 + (position - u0) / (u1 - u0) * (v1 - v0))
        } else {
            return fallbackValue // case other property
        }
    }

    update(event: Dragging.Event): void {
        const {clientX, clientY} = event
        const {left, top} = this.#element.getBoundingClientRect()
        this.#lineEnd.u = this.#range.xToUnit(clientX - left)
        this.#lineEnd.v = clamp(this.#valueAxis.axisToValue(clientY - top), 0.0, 1.0)
        this.#dispatchChange()
    }

    approve(): void {
        const result: ReadonlyArray<{ adapter: NoteEventBoxAdapter, value: number }> =
            this.#reader.content.events.asArray()
                .map(adapter => ({adapter, value: this.#modifyProperty(this.#property, adapter)}))
        this.#editing.modify(() => result.forEach(({adapter: {box}, value}) =>
            this.#property.writeValue(box, value)))
    }

    cancel(): void {
        this.#lineEnd.u = this.#lineOrigin.u
        this.#lineEnd.v = this.#lineOrigin.v
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}