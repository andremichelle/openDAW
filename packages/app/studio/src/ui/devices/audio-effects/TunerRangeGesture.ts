import {clamp, isDefined, Procedure} from "@opendaw/lib-std"
import {fitTunerCanvas, TunerLayout} from "./TunerCanvasLayout"
import {TunerRange, TunerViewState} from "./TunerViewState"

export class TunerRangeGesture {
    readonly #state: TunerViewState
    readonly #range: TunerRange
    readonly #width: number
    readonly #height: number
    readonly #commit: Procedure<TunerRange>

    constructor(state: TunerViewState, width: number, height: number, commit: Procedure<TunerRange>) {
        this.#state = state
        this.#range = {center: state.center, span: state.span}
        const {scale} = fitTunerCanvas(width, height)
        this.#width = (TunerLayout.historyRight - TunerLayout.left) * scale
        this.#height = TunerLayout.historyHeight * scale
        this.#commit = commit
    }

    move(horizontal: number, vertical: number): void {
        if (this.#width <= 0 || this.#height <= 0) {return}
        this.#state.preview = {
            center: clamp(this.#range.center + vertical / this.#height * this.#range.span, 12, 120),
            span: clamp(this.#range.span * Math.exp(horizontal / this.#width * 2), 2, 24)
        }
    }

    approve(): void {
        const preview = this.#state.preview
        this.#state.preview = undefined
        if (isDefined(preview)) {this.#commit(preview)}
    }

    cancel(): void {
        this.#state.preview = undefined
        this.#state.center = this.#range.center
        this.#state.span = this.#range.span
    }
}
