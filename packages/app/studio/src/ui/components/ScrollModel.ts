import {clamp, Notifier, Observer, Subscription, Terminable} from "@moises-ai/lib-std"

export class ScrollModel implements Terminable {
    static readonly #MinThumbSize = 16.0

    readonly #notifier: Notifier<ScrollModel>

    #trackSize: number = 0.0
    #visibleSize: number = 0.0
    #contentSize: number = 0.0
    #normalized: number = 0.0

    constructor() {this.#notifier = new Notifier<ScrollModel>()}

    moveTo(value: number): void {
        if (!this.scrollable()) {return}
        this.normalized = value / (this.#trackSize - this.thumbSize)
    }

    moveBy(delta: number): void {
        if (0.0 === delta || !this.scrollable()) {return}
        this.normalized = (this.#normalized + delta / (this.overflow))
    }

    subscribe(observer: Observer<ScrollModel>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {this.#notifier.terminate()}

    // The size if the visible area of the underlying content
    set visibleSize(value: number) {
        if (this.#visibleSize === value) {return}
        this.#visibleSize = value
        if (!this.scrollable()) {
            this.#normalized = 0
        }
        this.#onChanged()
    }
    get visibleSize(): number {return this.#visibleSize}

    // The size of the scroller's track
    set trackSize(value: number) {
        if (this.#trackSize === value) {return}
        this.#trackSize = value
        this.#onChanged()
    }
    get trackSize(): number {return this.#trackSize}

    // The size of the underlying content
    set contentSize(value: number) {
        if (this.#contentSize === value) {return}
        this.#contentSize = value
        this.#normalized = !this.scrollable()
            ? 0.0
            : Math.max(0.0, Math.min(1.0, this.#normalized * this.overflow / (this.#contentSize - this.#visibleSize)))
        this.#onChanged()
    }
    get contentSize(): number {return this.#contentSize}

    // the normalized thumb position
    set normalized(value: number) {
        const clamped = !this.scrollable() ? 0.0 : clamp(value, 0.0, 1.0)
        if (this.#normalized === clamped) {return}
        this.#normalized = clamped
        this.#onChanged()
    }
    get normalized(): number {return this.#normalized}

    set position(value: number) {
        if (!this.scrollable()) {return}
        this.normalized = value / (this.overflow)
    }
    get position() {return !this.scrollable() ? 0.0 : Math.floor(this.#normalized * this.overflow)}

    get overflow() {return this.#contentSize - this.#visibleSize}
    get thumbPosition() {return this.#normalized * (this.#trackSize - this.#minThumbSize())}
    get thumbSize() {return !this.scrollable() ? this.#trackSize : this.#minThumbSize()}

    ensureVisibility(top: number, bottom: number): void {
        if (!this.scrollable()) {return}
        let min = this.position
        let max = this.visibleSize + min
        if (bottom > max) {
            this.moveBy(bottom - max)
            min = this.position
        }
        if (top < min) {
            this.moveBy(top - min)
        }
    }

    scrollable(): boolean {return this.#contentSize > this.#visibleSize}

    #minThumbSize(): number {
        return Math.max(ScrollModel.#MinThumbSize, this.#visibleSize / this.#contentSize * this.#trackSize)
    }

    #onChanged(): void {this.#notifier.notify(this)}
}