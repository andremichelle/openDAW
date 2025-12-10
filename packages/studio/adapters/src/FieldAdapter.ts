import {
    clamp,
    MutableObservableValue,
    Notifier,
    Observer,
    Option,
    StringMapping,
    StringResult,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    ValueMapping
} from "@opendaw/lib-std"
import {Address, PrimitiveField, PrimitiveType, PrimitiveValues} from "@opendaw/lib-box"
import {TrackBoxAdapter} from "./timeline/TrackBoxAdapter"

export class FieldAdapter<T extends PrimitiveValues = any> implements MutableObservableValue<T>, Terminable {
    readonly #field: PrimitiveField<T>
    readonly #valueMapping: ValueMapping<T>
    readonly #stringMapping: StringMapping<T>
    readonly #name: string
    readonly #anchor: unitValue

    readonly #terminator: Terminator = new Terminator()
    readonly #valueChangeNotifier: Notifier<this>

    #trackBoxAdapter: Option<TrackBoxAdapter> = Option.None

    constructor(field: PrimitiveField<T, any>,
                valueMapping: ValueMapping<T>,
                stringMapping: StringMapping<T>,
                name: string,
                anchor?: unitValue) {
        this.#field = field
        this.#valueMapping = valueMapping
        this.#stringMapping = stringMapping
        this.#name = name
        this.#anchor = anchor ?? 0.0
        this.#valueChangeNotifier = this.#terminator.own(new Notifier<this>())
        this.#terminator.own(this.#field.subscribe(() => this.#valueChangeNotifier.notify(this)))

        /*
        For debugging: It's not live because floating errors expose false positives,
            and I am too lazy to implement this in the mappings itself.
        */
        if (field.getValue() !== valueMapping.clamp(field.getValue())) {
            // console.warn(`${name} (${field.getValue()}) is out of bounds`, valueMapping)
        }
    }

    get field(): PrimitiveField<T> {return this.#field}
    get valueMapping(): ValueMapping<T> {return this.#valueMapping}
    get stringMapping(): StringMapping<T> {return this.#stringMapping}
    get name(): string {return this.#name}
    get anchor(): unitValue {return this.#anchor}
    get type(): PrimitiveType {return this.#field.type}
    get address(): Address {return this.#field.address}
    get track(): Option<TrackBoxAdapter> {return this.#trackBoxAdapter}

    subscribe(observer: Observer<FieldAdapter<T>>): Subscription {return this.#valueChangeNotifier.subscribe(observer)}

    catchupAndSubscribe(observer: Observer<FieldAdapter<T>>): Subscription {
        observer(this)
        return this.subscribe(observer)
    }

    getValue(): T {return this.#field.getValue()}
    setValue(value: T) {this.#field.setValue(this.#valueMapping.clamp(value))}
    setUnitValue(value: unitValue): void {this.setValue(this.#valueMapping.y(value))}
    getUnitValue(): unitValue {return this.#valueMapping.x(this.getValue())}
    getPrintValue(): Readonly<StringResult> {return this.#stringMapping.x(this.getValue())}
    setPrintValue(text: string): void {
        const result = this.#stringMapping.y(text)
        if (result.type === "unitValue") {
            this.setUnitValue(clamp(result.value, 0.0, 1.0))
        } else if (result.type === "explicit") {
            this.setValue(this.valueMapping.clamp(result.value))
        } else {
            console.debug(`Unknown text input: '${result.value}'`)
        }
    }

    reset(): void {this.setValue(this.#valueMapping.clamp(this.#field.initValue))}

    terminate(): void {this.#terminator.terminate()}
}