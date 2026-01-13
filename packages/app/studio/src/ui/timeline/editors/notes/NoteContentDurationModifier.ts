import {int, Notifier, Observer, Option, Terminable} from "@moises-ai/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {Line, NoteModifyStrategy} from "./NoteModifyStrategies"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {ppqn} from "@moises-ai/lib-dsp"
import {UINoteEvent} from "./UINoteEvent"
import {Dragging} from "@moises-ai/lib-dom"

type Construct = Readonly<{
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: NoteEventOwnerReader
}>

export class NoteContentDurationModifier implements NoteModifier {
    static create(construct: Construct): NoteContentDurationModifier {
        return new NoteContentDurationModifier(construct)
    }

    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: NoteEventOwnerReader
    readonly #notifier: Notifier<void>

    #deltaLoopDuration: ppqn

    private constructor({element, snapping, pointerPulse, reference}: Construct) {
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference

        this.#notifier = new Notifier<void>()

        this.#deltaLoopDuration = 0
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return false}
    showCreation(): Option<UINoteEvent> {return Option.None}
    showPropertyLine(): Option<Line> {return Option.None}
    readContentDuration(region: NoteEventOwnerReader): number {
        return Math.max(region.loopDuration + this.#deltaLoopDuration,
            Math.min(region.loopDuration, this.#snapping.value(region.position)))
    }
    selectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}
    unselectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}

    update({clientX}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const deltaLoopDuration: int = this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.loopDuration)
        if (this.#deltaLoopDuration !== deltaLoopDuration) {
            this.#deltaLoopDuration = deltaLoopDuration
            this.#dispatchChange()
        }
    }

    approve(editing: BoxEditing): void {
        if (this.#deltaLoopDuration === 0) {return}
        editing.modify(() =>
            this.#reference.contentDuration = this.readContentDuration(this.#reference))
    }

    cancel(): void {
        this.#deltaLoopDuration = 0
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}