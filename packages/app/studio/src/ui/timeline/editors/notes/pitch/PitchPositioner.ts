import {clamp, int, Notifier, Observer, Subscription, Terminable, Terminator, ValueAxis} from "@moises-ai/lib-std"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"

export class PitchPositioner implements Terminable {
    readonly #numNotes: int = 128
    readonly #terminator: Terminator = new Terminator()
    readonly #notifier: Notifier<PitchPositioner>
    readonly #scrollModel: ScrollModel
    readonly #valueAxis: ValueAxis

    #noteHeight: int = 11
    #totalHeight: int

    constructor() {
        this.#notifier = new Notifier<PitchPositioner>()
        this.#totalHeight = this.#noteHeight * this.#numNotes
        this.#scrollModel = this.#terminator.own(new ScrollModel())
        this.#scrollModel.contentSize = this.totalHeight
        this.#terminator.own(this.#scrollModel.subscribe(() => this.position = this.#scrollModel.position))
        this.#valueAxis = {
            axisToValue: (y: number) => clamp((this.#totalHeight - y -
                Math.round(this.#scrollModel.position)) / this.#noteHeight, 0, this.#numNotes) - 1.0,
            valueToAxis: (x: number) => this.pitchToY(x)
        }
    }

    moveBy(pixels: number): void {this.position = this.#scrollModel.position + pixels}

    set centerNote(note: int) {
        if (this.height === 0) {
            console.warn("Cannot set 'centerNote'. Height is zero.")
            return
        }
        this.#scrollModel.position = (this.#totalHeight - (note + 0.5) * this.#noteHeight) - this.height * 0.5
    }
    get centerNote(): int {
        return -Math.round(0.5 + (this.#scrollModel.position + this.height * 0.5 - this.#totalHeight) / this.#noteHeight)
    }

    pitchToY(note: int): number {return this.#totalHeight - (note + 1) * this.#noteHeight - Math.round(this.#scrollModel.position)}
    yToPitch(y: number): int {return Math.floor((this.#totalHeight - y - Math.round(this.#scrollModel.position)) / this.#noteHeight)}
    subscribe(observer: Observer<PitchPositioner>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {this.#terminator.terminate()}

    get scrollModel(): ScrollModel {return this.#scrollModel}
    get valueAxis(): ValueAxis {return this.#valueAxis}
    set height(value: number) {this.#scrollModel.trackSize = this.#scrollModel.visibleSize = value}
    get height(): number {return this.#scrollModel.visibleSize}
    set position(value: number) {
        this.#scrollModel.position = value
        this.#notifier.notify(this)
    }
    get position(): number {return this.#scrollModel.position}
    set noteHeight(value: int) {
        value = Math.floor(value)
        if (this.#noteHeight === value) {return}
        const anchor = this.centerNote
        this.#noteHeight = value
        this.#totalHeight = this.#noteHeight * this.#numNotes
        this.#scrollModel.contentSize = this.#totalHeight
        if (this.centerNote === anchor) {
            this.#notifier.notify(this)
        } else {
            this.centerNote = anchor
        }
    }
    get noteHeight(): int {return this.#noteHeight}
    get totalHeight(): int {return this.#totalHeight}
}