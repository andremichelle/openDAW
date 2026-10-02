import {clamp, DefaultObservableValue, int, MutableObservableValue, ObservableValue} from "@opendaw/lib-std"

export class ClipsView {
    static readonly MinColumns: int = 16
    static readonly DefaultVisible: int = 3

    readonly visible: MutableObservableValue<boolean>

    readonly #columns: DefaultObservableValue<int>
    readonly #count: DefaultObservableValue<int>
    readonly #scroll: DefaultObservableValue<int>

    constructor(visible: MutableObservableValue<boolean>) {
        this.visible = visible
        this.#columns = new DefaultObservableValue(ClipsView.MinColumns)
        this.#count = new DefaultObservableValue(ClipsView.DefaultVisible)
        this.#scroll = new DefaultObservableValue(0)
    }

    get columns(): ObservableValue<int> {return this.#columns}
    get count(): ObservableValue<int> {return this.#count}
    get scroll(): ObservableValue<int> {return this.#scroll}

    setCount(count: int, fit: int): void {
        const max = Math.max(1, Math.min(this.#columns.getValue(), fit))
        this.#count.setValue(clamp(count, 1, max))
        this.scrollTo(this.#scroll.getValue())
    }

    scrollTo(index: int): void {
        this.#scroll.setValue(clamp(index, 0, this.#columns.getValue() - this.#count.getValue()))
    }

    scrollBy(delta: int): void {this.scrollTo(this.#scroll.getValue() + delta)}

    ensureColumn(index: int): void {this.#columns.setValue(Math.max(this.#columns.getValue(), index + 2))}

    reveal(index: int): void {
        const scroll = this.#scroll.getValue()
        const count = this.#count.getValue()
        if (index < scroll) {
            this.scrollTo(index)
        } else if (index >= scroll + count) {
            this.scrollTo(index - count + 1)
        }
    }

    reset(highestIndex: int): void {
        this.#columns.setValue(Math.max(ClipsView.MinColumns, highestIndex + 2))
        this.#count.setValue(clamp(this.#count.getValue(), 1, this.#columns.getValue()))
        this.#scroll.setValue(0)
    }
}
