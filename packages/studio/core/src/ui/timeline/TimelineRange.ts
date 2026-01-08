import {
    Notifier,
    Observer,
    panic,
    Range,
    RangeOptions,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    ValueAxis
} from "@opendaw/lib-std"

export class TimelineRange implements Terminable {
    readonly #terminator: Terminator
    readonly #range: Range
    readonly #notifier: Notifier<TimelineRange>
    readonly #valueAxis: ValueAxis

    #maxUnits: number = 1.0
    #minimum: number = 1.0

    constructor(options?: RangeOptions) {
        this.#terminator = new Terminator()
        this.#range = this.#terminator.own(new Range(options))
        this.#notifier = this.#terminator.own(new Notifier<TimelineRange>())
        this.#valueAxis = {
            valueToAxis: (value: number): number => this.unitToX(Math.max(0, value)),
            axisToValue: (x: number): number => Math.max(0, this.xToUnit(x))
        }

        this.#terminator.own(this.#range.subscribe(() => this.#notifier.notify(this)))
    }

    subscribe(observer: Observer<TimelineRange>): Subscription {return this.#notifier.subscribe(observer)}

    get minUnits(): number {return 0}
    set minUnits(_: number) {
        panic("minUnits not implemented")
    }

    get maxUnits(): number {return this.#maxUnits}
    set maxUnits(value: number) {
        if (this.#maxUnits === value) {return}
        this.#maxUnits = value
        this.#range.minimum = this.normalize(this.#minimum)
    }

    get unitCenter(): number {return this.toUnits(this.#range.center)}
    set unitCenter(value: number) {this.#range.center = this.normalize(value)}

    get width(): number {return this.#range.width}
    set width(value: number) {this.#range.width = value}

    // minimum interval
    get minimum(): number {return this.#minimum}
    set minimum(value: number) {this.#minimum = value}

    get unitMin(): number {return this.toUnits(this.#range.min)}
    set unitMin(value: number) {this.#range.min = this.normalize(value)}
    get unitMax(): number {return this.toUnits(this.#range.max)}
    set unitMax(value: number) {this.#range.max = this.normalize(value)}
    get unitsPerPixel(): number {return this.toUnits(this.#range.valuesPerPixel)}
    get unitRange(): number {return this.unitMax - this.unitMin}
    get valueAxis(): ValueAxis {return this.#valueAxis}
    normalize(value: number): unitValue {return value / this.maxUnits}
    toUnits(value: number): unitValue {return value * this.maxUnits}
    unitToX(unit: number): number {return this.valueToX(this.normalize(unit))}
    xToUnit(x: number): number {return this.toUnits(this.xToValue(x))}
    moveToUnit(value: number): void {this.#range.moveTo(this.normalize(value))}
    unitOverlaps(min: number, max: number): boolean {return this.#range.overlaps(this.normalize(min), this.normalize(max))}
    showUnitInterval(min: number, max: number): void {this.#range.set(this.normalize(min), this.normalize(max))}
    showAll(): void {this.#range.set(0.0, 1.0)}
    zoomRange(min: number, max: number, padding: number = 32): void {
        const innerWidth = this.#range.innerWidth
        const unitsPerPixel = (max - min) / (innerWidth - padding * 2.0)
        const center = ((min + max) / 2.0) / this.#maxUnits
        const range = Math.max(this.#range.minimum, (unitsPerPixel * innerWidth) / this.#maxUnits * 0.5)
        let a = center - range
        let b = center + range
        if (a < 0.0) {
            b -= a
            a = 0.0
        }
        this.#range.set(a, b)
    }
    moveUnitTo(value: number): void {this.#range.moveTo(this.normalize(value))}
    moveUnitBy(delta: number): void {this.#range.moveBy(this.normalize(delta))}
    scaleUnitBy(scale: number, position: unitValue): void {this.#range.scaleBy(scale, this.normalize(position))}
    get unitPadding(): number {return this.#range.padding * this.unitsPerPixel}
    get min(): unitValue {return this.#range.min}
    set min(value: unitValue) {this.#range.min = value}
    get max(): unitValue {return this.#range.max}
    set max(value: unitValue) {this.#range.max = value}
    get center(): unitValue {return this.#range.center}
    set center(value: unitValue) {this.#range.center = value}
    get length(): unitValue {return this.#range.length}
    moveTo(value: unitValue): void {this.#range.moveTo(value)}
    moveBy(delta: unitValue): void {this.#range.moveBy(delta)}
    scaleBy(scale: number, position: unitValue): void {this.#range.scaleBy(scale, position)}
    xToValue(x: number): unitValue {return this.#range.xToValue(x)}
    valueToX(value: unitValue): number {return this.#range.valueToX(value)}
    overlaps(start: number, complete: number): boolean {return this.#range.overlaps(start, complete)}

    terminate(): void {this.#terminator.terminate()}
}