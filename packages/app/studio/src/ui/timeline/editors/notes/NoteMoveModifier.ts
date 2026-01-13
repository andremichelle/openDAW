import {
    byte,
    clamp,
    int,
    Notifier,
    Observer,
    Option,
    Selection,
    Subscription,
    Terminable,
    unitValue
} from "@moises-ai/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {Line, NoteModifyStrategy} from "./NoteModifyStrategies"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"
import {EventCollection, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UINoteEvent} from "@/ui/timeline/editors/notes/UINoteEvent.ts"
import {Dragging} from "@moises-ai/lib-dom"

class SelectedModifyStrategy implements NoteModifyStrategy {
    readonly #tool: NoteMoveModifier

    constructor(tool: NoteMoveModifier) {this.#tool = tool}

    readPosition(adapter: NoteEventBoxAdapter): ppqn {return adapter.position + this.#tool.deltaPosition}
    readComplete(adapter: NoteEventBoxAdapter): ppqn {return adapter.complete + this.#tool.deltaPosition}
    readPitch(adapter: NoteEventBoxAdapter): number {return clamp(adapter.pitch + this.#tool.deltaPitch, 0, 127)}
    readVelocity(adapter: NoteEventBoxAdapter): unitValue {return adapter.velocity}
    readCent(adapter: NoteEventBoxAdapter): number {return adapter.cent}
    readChance(adapter: NoteEventBoxAdapter): number {return adapter.chance}
    iterateRange<R extends NoteEvent>(regions: EventCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(from - this.#tool.deltaPosition, to - this.#tool.deltaPosition)
    }
}

type Construct = Readonly<{
    element: Element
    selection: Selection<NoteEventBoxAdapter>
    positioner: PitchPositioner
    snapping: Snapping
    pointerPulse: ppqn
    pointerPitch: int
    reference: NoteEventBoxAdapter
}>

export class NoteMoveModifier implements NoteModifier {
    static create(construct: Construct): NoteMoveModifier {return new NoteMoveModifier(construct)}

    readonly #element: Element
    readonly #selection: Selection<NoteEventBoxAdapter>
    readonly #positioner: PitchPositioner
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #pointerPitch: int
    readonly #reference: NoteEventBoxAdapter

    readonly #notifier: Notifier<void>
    readonly #pitchChanged: Notifier<byte>
    readonly #selectedModifyStrategy: NoteModifyStrategy

    #copy: boolean
    #repeat: boolean
    #deltaPitch: int
    #deltaPosition: ppqn

    private constructor({element, selection, positioner, snapping, pointerPulse, pointerPitch, reference}: Construct) {
        this.#element = element
        this.#selection = selection
        this.#positioner = positioner
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#pointerPitch = pointerPitch
        this.#reference = reference

        this.#notifier = new Notifier<void>()
        this.#pitchChanged = new Notifier<byte>()
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#copy = false
        this.#repeat = false
        this.#deltaPitch = 0
        this.#deltaPosition = 0
    }

    subscribePitchChanged(observer: Observer<byte>): Subscription {return this.#pitchChanged.subscribe(observer)}
    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    get copy(): boolean {return this.#copy}
    get deltaPitch(): int {return this.#deltaPitch}
    get deltaPosition(): ppqn {return this.#deltaPosition}

    showOrigin(): boolean {return this.#copy}
    showCreation(): Option<UINoteEvent> {return Option.None}
    showPropertyLine(): Option<Line> {return Option.None}
    readContentDuration(region: NoteEventOwnerReader): number {return region.contentDuration}
    selectedModifyStrategy(): NoteModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): NoteModifyStrategy {return NoteModifyStrategy.Identity}

    update({clientX, clientY, ctrlKey, shiftKey}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const deltaPitch: int = this.#positioner
            .yToPitch(clientY - clientRect.top) - this.#pointerPitch
        const deltaPosition: int = this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.position)
        let change = false
        if (this.#deltaPosition !== deltaPosition) {
            this.#deltaPosition = deltaPosition
            change = true
        }
        if (this.#deltaPitch !== deltaPitch) {
            this.#deltaPitch = deltaPitch
            this.#pitchChanged.notify(this.#reference.pitch + deltaPitch)
            change = true
        }
        if (this.#copy !== ctrlKey) {
            this.#copy = ctrlKey
            change = true
        }
        if (change) {this.#dispatchChange()}
        this.#repeat = shiftKey
    }

    approve(editing: BoxEditing): void {
        if (this.#deltaPitch === 0 && this.#deltaPosition === 0) {
            if (this.#copy) {this.#dispatchChange()} // reset visuals
            return
        }
        const result = this.#selection.selected()
            .map<{ adapter: NoteEventBoxAdapter, pitch: int, position: ppqn }>(adapter => ({
                adapter,
                pitch: this.#selectedModifyStrategy.readPitch(adapter),
                position: this.#selectedModifyStrategy.readPosition(adapter)
            }))
        editing.modify(() => {
            if (this.#copy) {
                this.#selection.deselectAll()
                const events = this.#reference.collection.unwrap().box.events
                if (this.#repeat && this.#deltaPosition !== 0) {
                    const numberOfCopies = 1 // TODO Open a dialog and ask for number of copies
                    for (let i = 0; i < numberOfCopies; i++) {
                        result.map(({adapter, position}) => adapter.copyTo({
                            position: position + this.#deltaPosition * i,
                            pitch: this.#selectedModifyStrategy.readPitch(adapter),
                            events
                        }))
                    }
                } else {
                    this.#selection.select(...(result
                        .map(({adapter, position, pitch}) => adapter.copyTo({position, pitch, events}))))
                }
            } else {
                result.forEach(({adapter: {box}, position, pitch}) => {
                    box.pitch.setValue(pitch)
                    box.position.setValue(position)
                })
            }
        })
        this.#pitchChanged.terminate()
    }

    cancel(): void {
        this.#deltaPitch = 0
        this.#deltaPosition = 0
        this.#dispatchChange()
        this.#pitchChanged.terminate()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}