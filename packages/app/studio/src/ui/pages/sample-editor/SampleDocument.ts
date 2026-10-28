import {
    clamp,
    DefaultObservableValue,
    int,
    isDefined,
    Notifier,
    Nullable,
    Observer,
    Option,
    Subscription,
    UUID
} from "@opendaw/lib-std"
import {AudioData, AudioSplice} from "@opendaw/lib-dsp"
import {SampleMetaData} from "@opendaw/studio-adapters"

export type SampleRange = Readonly<{ from: int, to: int }>

export type SampleSource = Readonly<{ uuid: UUID.Bytes, meta: SampleMetaData }>

type Step = Readonly<{
    from: int
    before: AudioData
    after: AudioData
    selectionBefore: SampleRange
    selectionAfter: SampleRange
}>

export class SampleDocument {
    readonly selection: DefaultObservableValue<SampleRange>
    readonly #notifier: Notifier<SampleDocument>
    readonly #undo: Array<Step>
    readonly #redo: Array<Step>

    #audio: AudioData
    #name: string
    #source: Option<SampleSource>
    #savedStep: Nullable<Step>
    #modified: boolean

    constructor(audio: AudioData, name: string, source: Option<SampleSource>, modified: boolean = false) {
        this.#audio = audio
        this.#name = name
        this.#source = source
        this.selection = new DefaultObservableValue<SampleRange>({from: 0, to: 0})
        this.#notifier = new Notifier<SampleDocument>()
        this.#undo = []
        this.#redo = []
        this.#savedStep = null
        this.#modified = modified
    }

    get audio(): AudioData {return this.#audio}
    get name(): string {return this.#name}
    get source(): Option<SampleSource> {return this.#source}
    get canUndo(): boolean {return this.#undo.length > 0}
    get canRedo(): boolean {return this.#redo.length > 0}
    get hasUnsavedChanges(): boolean {return this.#modified || this.#topStep() !== this.#savedStep}
    get hasSelection(): boolean {
        const {from, to} = this.selection.getValue()
        return to > from
    }

    subscribe(observer: Observer<SampleDocument>): Subscription {return this.#notifier.subscribe(observer)}

    select(from: int, to: int): void {
        const limit = this.#audio.numberOfFrames
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        this.selection.setValue({from: clamp(Math.round(lo), 0, limit), to: clamp(Math.round(hi), 0, limit)})
    }

    selectAll(): void {this.select(0, this.#audio.numberOfFrames)}

    replace(from: int, removeCount: int, insert: AudioData, selectionAfter: SampleRange): void {
        const before = AudioSplice.slice(this.#audio, from, from + removeCount)
        const step: Step = {from, before, after: insert, selectionBefore: this.selection.getValue(), selectionAfter}
        this.#apply(step)
        this.#undo.push(step)
        this.#redo.length = 0
        this.#changed()
    }

    undo(): void {
        const step = this.#undo.pop()
        if (!isDefined(step)) {return}
        this.#apply({...step, before: step.after, after: step.before, selectionAfter: step.selectionBefore})
        this.#redo.push(step)
        this.#changed()
    }

    redo(): void {
        const step = this.#redo.pop()
        if (!isDefined(step)) {return}
        this.#apply(step)
        this.#undo.push(step)
        this.#changed()
    }

    markSaved(source: SampleSource, name: string): void {
        this.#source = Option.wrap(source)
        this.#name = name
        this.#savedStep = this.#topStep()
        this.#modified = false
        this.#notifier.notify(this)
    }

    #apply({from, before, after, selectionAfter}: Step): void {
        this.#audio = AudioSplice.splice(this.#audio, from, before.numberOfFrames, after)
        this.select(selectionAfter.from, selectionAfter.to)
    }

    #topStep(): Nullable<Step> {return this.#undo.at(-1) ?? null}

    #changed(): void {this.#notifier.notify(this)}
}
