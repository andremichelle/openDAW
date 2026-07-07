import {Observer} from "./observers"
import {Subscription} from "./terminable"
import {unitValue} from "./lang"
import {Notifier} from "./notifier"
import {Observable} from "./observables"

export type RangeOptions = {
    padding?: number
    minimum?: unitValue
}

export class Range implements Observable<Range> {
    readonly #changeNotifier = new Notifier<Range>()
    readonly #padding: number

    #minimum: unitValue

    #min: unitValue = 0.0
    #max: unitValue = 1.0
    #width: number

    constructor(options?: RangeOptions) {
        this.#minimum = options?.minimum ?? Number.EPSILON
        this.#padding = options?.padding ?? 0.0
        this.#width = this.#padding + 1.0
    }

    get padding(): number {return this.#padding}
    get minimum(): unitValue {return this.#minimum}
    set minimum(value: unitValue) {
        this.#minimum = value
        if (this.#min + this.#minimum > this.#max) {
            this.#min = Math.max(0.0, this.#max - this.#minimum)
            this.#max = this.#min + this.#minimum
        }
        this.#changeNotifier.notify(this)
    }

    subscribe(observer: Observer<Range>): Subscription {return this.#changeNotifier.subscribe(observer)}
    terminate(): void {this.#changeNotifier.terminate()}

    moveTo(value: unitValue): void {
        let delta = value - this.#min
        if (this.#min + delta < 0.0) {
            delta = -this.#min
        } else if (this.#max + delta > 1.0) {
            delta = 1.0 - this.#max
        }
        this.set(this.#min + delta, this.#max + delta)
    }

    moveBy(delta: unitValue): void {
        if (this.#min + delta < 0.0) {delta = -this.#min}
        if (this.#max + delta > 1.0) {delta = 1.0 - this.#max}
        this.set(this.#min + delta, this.#max + delta)
    }

    get min(): unitValue {return this.#min}
    set min(value: unitValue) {
        if (value < 0.0) {
            this.set(0.0, this.#max)
        } else if (value + this.#minimum > this.#max) {
            this.set(this.#max - this.#minimum, this.#max)
        } else {
            this.set(value, this.#max)
        }
    }

    get max(): unitValue {return this.#max}
    set max(value: unitValue) {
        if (value > 1.0) {
            this.set(this.#min, 1.0)
        } else if (value < this.#min + this.#minimum) {
            this.set(this.#min, this.#min + this.#minimum)
        } else {
            this.set(this.#min, value)
        }
    }

    get length(): unitValue {return this.#max - this.#min}
    get valuesPerPixel(): number {return this.length / this.innerWidth}

    get center(): unitValue {return (this.#min + this.#max) * 0.5}
    set center(value: unitValue) {
        const range = this.#max - this.#min
        const rangeHalf = range / 2.0
        let min = value - rangeHalf
        let max = value + rangeHalf
        if (min < 0.0) {
            min = 0.0
            max = range
        }
        if (max > 1.0) {
            min = 1.0 - range
            max = 1.0
        }
        this.set(min, max)
    }

    scaleBy(scale: number, position: unitValue): void {
        if (scale === 0.0) {return}
        const range = this.#max - this.#min
        const s: number = this.#min + (this.#min - position) * scale
        const e: number = this.#max + (this.#max - position) * scale
        if (scale > 0.0) {
            if (s < 0.0) {
                this.set(0.0, range * Math.pow(2.0, scale))
            } else if (e > 1.0) {
                this.set(1.0 - range * Math.pow(2.0, scale), 1.0)
            } else {
                this.set(s, e)
            }
        } else if (e - s < this.#minimum) {
            const ratio = (this.#minimum - range) / range
            this.set(this.#min + (this.#min - position) * ratio, this.#max + (this.#max - position) * ratio)
        } else {
            this.set(s, e)
        }
    }

    xToValue(x: number): unitValue {return this.#min + (x - this.#padding) / this.innerWidth * this.length}
    valueToX(value: unitValue): number {return this.#padding + (value - this.#min) / this.length * this.innerWidth}

    showAll(): void {this.set(0.0, 1.0)}
    overlaps(start: number, complete: number): boolean {return complete > this.#min && start < this.#max}

    set width(value: number) {
        if (this.#width === value) {return}
        this.#width = value
        this.#changeNotifier.notify(this)
    }
    get width() {return this.#width}
    // Collapsed layouts can report widths <= padding. Clamping keeps every x <-> value mapping
    // finite — a division by zero here would poison #min/#max with NaN for good.
    get innerWidth() {return Math.max(1.0, this.#width - this.#padding)}

    set(min: unitValue, max: unitValue): void {
        const clampMin = Math.max(0.0, min)
        const clampMax = Math.min(1.0, max)
        if (this.#min !== clampMin || this.#max !== clampMax) {
            this.#min = clampMin
            this.#max = clampMax
            this.#changeNotifier.notify(this)
        }
    }
}