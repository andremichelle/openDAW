import {int, Notifier, Observer, Option, Selection, Terminable, unitValue} from "@opendaw/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@opendaw/lib-box"
import {Line, NoteModifyStrategy} from "./NoteModifyStrategies"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {EventCollection, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UINoteEvent} from "./UINoteEvent"
import {Dragging} from "@opendaw/lib-dom"

class SelectedModifyStrategy implements NoteModifyStrategy {
    readonly #tool: NoteDurationModifier

    constructor(tool: NoteDurationModifier) {this.#tool = tool}

    readPosition(adapter: NoteEventBoxAdapter): ppqn {return adapter.position}
    readComplete(adapter: NoteEventBoxAdapter): ppqn {
        const duration = this.#tool.aligned
            ? (this.#tool.reference.position + this.#tool.reference.duration + this.#tool.deltaDuration) - adapter.position
            : adapter.duration + this.#tool.deltaDuration
        return adapter.position + Math.max(Math.min(this.#tool.snapping.value(adapter.position), adapter.duration), duration)
    }
    readPitch(adapter: NoteEventBoxAdapter): number {return adapter.pitch}
    readVelocity(adapter: NoteEventBoxAdapter): unitValue {return adapter.velocity}
    readCent(adapter: NoteEventBoxAdapter): number {return adapter.cent}
    readChance(adapter: NoteEventBoxAdapter): number {return adapter.chance}
    iterateRange<R extends NoteEvent>(regions: EventCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(
            this.#tool.selection.selected().reduce((from, adapter) => Math.min(from, adapter.position), from), to)
    }
}

type Construct = Readonly<{
    editing: BoxEditing
    element: Element
    selection: Selection<NoteEventBoxAdapter>
    snapping: Snapping
    pointerPulse: ppqn
    reference: NoteEventBoxAdapter
}>

export class NoteDurationModifier implements NoteModifier {
    static create(construct: Construct): NoteDurationModifier {
        return new NoteDurationModifier(construct)
    }

    readonly #editing: BoxEditing
    readonly #element: Element
    readonly #selection: Selection<NoteEventBoxAdapter>
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: NoteEventBoxAdapter

    readonly #notifier: Notifier<void>
    readonly #selectedModifyStrategy: NoteModifyStrategy

    #aligned: boolean
    #deltaDuration: ppqn

    private constructor({editing, element, selection, snapping, pointerPulse, reference}: Construct) {
        this.#editing = editing
        this.#element = element
        this.#selection = selection
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference

        this.#notifier = new Notifier<void>()
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#aligned = false
        this.#deltaDuration = 0
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    get aligned(): boolean {return this.#aligned}
    get reference(): NoteEventBoxAdapter {return this.#reference}
    get snapping(): Snapping {return this.#snapping}
    get deltaDuration(): ppqn {return this.#deltaDuration}
    get selection(): Selection<NoteEventBoxAdapter> {return this.#selection}

    showOrigin(): boolean {return false}
    showCreation(): Option<UINoteEvent> {return Option.None}
    showPropertyLine(): Option<Line> {return Option.None}
    readContentDuration(region: NoteEventOwnerReader): number {return region.contentDuration}
    selectedModifyStrategy(): NoteModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}

    update({clientX, ctrlKey: aligned}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const deltaDuration: int = this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.duration)
        let change = false
        if (this.#aligned !== aligned) {
            this.#aligned = aligned
            change = true
        }
        if (this.#deltaDuration !== deltaDuration) {
            this.#deltaDuration = deltaDuration
            change = true
        }
        if (change) {
            this.#dispatchChange()
        }
    }

    approve(): void {
        if (this.#deltaDuration === 0) {return}
        const result = this.#selection.selected()
            .map<{ adapter: NoteEventBoxAdapter, duration: ppqn }>(adapter => ({
                adapter,
                duration: this.#selectedModifyStrategy.readComplete(adapter)
                    - this.#selectedModifyStrategy.readPosition(adapter)
            }))
        this.#editing.modify(() => result
            .forEach(({adapter: {box}, duration}) => box.duration.setValue(duration)))
    }

    cancel(): void {
        this.#deltaDuration = 0
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}