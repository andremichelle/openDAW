import {clamp, Editing, int, Notifier, Observer, Option, Selection, Terminable, unitValue} from "@opendaw/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {Line, NoteModifyStrategy} from "./NoteModifyStrategies"
import {ppqn} from "@opendaw/lib-dsp"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Dragging} from "@opendaw/lib-dom"
import {NoteDrawDefaults} from "@/ui/timeline/editors/notes/NoteDrawDefaults.ts"

// Vertical slack before the velocity follows the pointer, so shaping the duration leaves it untouched
const VelocityThreshold = 12
const VelocityRange = 128 // pixels for the entire velocity range
const VelocitySteps = 127

type Construct = Readonly<{
    editing: Editing
    element: Element
    snapping: Snapping
    selection: Selection<NoteEventBoxAdapter>
    pointerPulse: ppqn
    pointerPitch: int
    pointerClientY: number
    reference: NoteEventOwnerReader
}>

export class NoteCreateModifier implements NoteModifier {
    static create(construct: Construct): NoteCreateModifier {
        return new NoteCreateModifier(construct)
    }

    readonly #editing: Editing
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #pointerClientY: number
    readonly #reference: NoteEventOwnerReader

    readonly #notifier: Notifier<void>
    readonly #note: NoteEventBoxAdapter

    #duration: ppqn
    #velocity: unitValue

    private constructor({
                            editing, element, snapping, selection,
                            pointerPulse, pointerPitch, pointerClientY, reference
                        }: Construct) {
        this.#editing = editing
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#pointerClientY = pointerClientY
        this.#reference = reference

        this.#notifier = new Notifier<void>()

        const position = this.#snapping.floor(pointerPulse)
        this.#duration = NoteDrawDefaults.durationOr(snapping.value(position))
        this.#velocity = NoteDrawDefaults.velocity
        // The note is real from the first pointer event, so a running loop plays the duration and velocity changes
        this.#note = editing.modify(() => {
            const note = reference.content.createEvent({
                position, duration: this.#duration, velocity: this.#velocity,
                pitch: pointerPitch, cent: 0.0, chance: 100, playCount: 1
            })
            selection.deselectAll()
            selection.select(note)
            return note
        }, false).unwrap("createEvent")
    }

    get note(): NoteEventBoxAdapter {return this.#note}

    subscribeUpdate(observer: Observer<void>): Terminable {
        observer()
        return this.#notifier.subscribe(observer)
    }

    showOrigin(): boolean {return false}
    showPropertyLine(): Option<Line> {return Option.None}
    readContentDuration(region: NoteEventOwnerReader): number {return region.contentDuration}
    selectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}
    unselectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}

    update({clientX, clientY}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const minDuration = this.#snapping.value(this.#note.position)
        const initialDuration = NoteDrawDefaults.durationOr(minDuration)
        const deltaDuration: int = this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, initialDuration)
        const duration = Math.max(initialDuration + deltaDuration - this.#reference.offset, minDuration)
        const velocity = this.#readVelocity(clientY)
        if (this.#duration === duration && this.#velocity === velocity) {return}
        this.#duration = duration
        this.#velocity = velocity
        this.#editing.modify(() => {
            this.#note.box.duration.setValue(duration)
            this.#note.box.velocity.setValue(velocity)
        }, false)
        this.#notifier.notify()
    }

    approve(): void {
        NoteDrawDefaults.remember(this.#note)
        this.#editing.mark()
    }

    cancel(): void {
        this.#editing.modify(() => this.#note.box.delete(), false)
        this.#notifier.notify()
    }

    #readVelocity(clientY: number): unitValue {
        const distance = this.#pointerClientY - clientY
        const beyond = Math.sign(distance) * Math.max(Math.abs(distance) - VelocityThreshold, 0.0)
        const velocity = NoteDrawDefaults.velocity + beyond / VelocityRange
        return clamp(Math.round(velocity * VelocitySteps) / VelocitySteps, 0.0, 1.0)
    }
}