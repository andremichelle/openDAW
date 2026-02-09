import {int, Notifier, Observer, Option, Terminable, unitValue} from "@opendaw/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@opendaw/lib-box"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Interpolation, ppqn, PPQN, ValueEvent} from "@opendaw/lib-dsp"
import {ValueModifier} from "./ValueModifier"
import {SelectableValueEvent} from "@opendaw/studio-adapters"
import {Dragging} from "@opendaw/lib-dom"

type Construct = Readonly<{
    editing: BoxEditing
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: ValueEventOwnerReader
}>

export class ValueContentDurationModifier implements ValueModifier {
    static create(construct: Construct): ValueContentDurationModifier {
        return new ValueContentDurationModifier(construct)
    }

    readonly #editing: BoxEditing
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: ValueEventOwnerReader
    readonly #notifier: Notifier<void>

    #deltaLoopDuration: ppqn

    private constructor({editing, element, snapping, pointerPulse, reference}: Construct) {
        this.#editing = editing
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference

        this.#notifier = new Notifier<void>()
        this.#deltaLoopDuration = 0
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return false}
    snapValue(): Option<unitValue> {return Option.None}
    readPosition(event: ValueEvent): ppqn {return event.position}
    readValue(event: ValueEvent): unitValue {return event.value}
    readInterpolation(event: SelectableValueEvent): Interpolation {return event.interpolation}
    translateSearch(value: ppqn): ppqn {return value}
    isVisible(_event: SelectableValueEvent): boolean {return true}
    iterator(searchMin: ppqn, searchMax: ppqn): IterableIterator<SelectableValueEvent> {
        return this.#reference.content.events.iterateRange(searchMin, searchMax)
    }
    readContentDuration(region: ValueEventOwnerReader): number {
        return Math.max(region.loopDuration + this.#deltaLoopDuration,
            Math.min(region.loopDuration, PPQN.SemiQuaver))
    }

    update({clientX}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const deltaLoopDuration: int = this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.loopDuration)
        if (this.#deltaLoopDuration !== deltaLoopDuration) {
            this.#deltaLoopDuration = deltaLoopDuration
            this.#dispatchChange()
        }
    }

    approve(): void {
        if (this.#deltaLoopDuration === 0) {return}
        this.#editing.modify(() => this.#reference.contentDuration = this.readContentDuration(this.#reference))
    }

    cancel(): void {
        this.#deltaLoopDuration = 0
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}