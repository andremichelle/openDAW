import {
    assert,
    clamp,
    ControlSource,
    ControlSourceListener,
    Listeners,
    Notifier,
    Nullable,
    Observer,
    Option,
    panic,
    Parameter,
    StringMapping,
    StringResult,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    ValueMapping
} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {Address, PointerField, PointerTypes, PrimitiveField, PrimitiveType, PrimitiveValues} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {BoxVisitor, TrackBox} from "@opendaw/studio-boxes"
import {TrackBoxAdapter} from "./timeline/TrackBoxAdapter"
import {BoxAdaptersContext} from "./BoxAdaptersContext"

const ExternalControlTypes = [
    Pointers.Automation,
    Pointers.Modulation,
    Pointers.MIDIControl,
    Pointers.ParameterController] as const

export class AutomatableParameterFieldAdapter<T extends PrimitiveValues = any> implements Parameter<T>, Terminable {
    readonly #context: BoxAdaptersContext
    readonly #field: PrimitiveField<T, Pointers.Automation>
    readonly #valueMapping: ValueMapping<T>
    readonly #stringMapping: StringMapping<T>
    readonly #name: string
    readonly #anchor: unitValue

    readonly #terminator: Terminator = new Terminator()
    readonly #valueChangeNotifier: Notifier<this>
    readonly #controlSource: Listeners<ControlSourceListener>

    #trackBoxAdapter: Option<TrackBoxAdapter> = Option.None
    #automationHandle: Option<Terminable> = Option.None
    #controlledValue: Nullable<unitValue> = null
    #midiControlled: boolean = false

    constructor(context: BoxAdaptersContext,
                field: PrimitiveField<T, any>,
                valueMapping: ValueMapping<T>,
                stringMapping: StringMapping<T>,
                name: string,
                anchor?: unitValue) {
        this.#context = context
        this.#field = field
        this.#valueMapping = valueMapping
        this.#stringMapping = stringMapping
        this.#name = name
        this.#anchor = anchor ?? 0.0
        this.#terminator.own(this.#context.parameterFieldAdapters.register(this))
        this.#valueChangeNotifier = this.#terminator.own(new Notifier<this>())
        this.#controlSource = new Listeners<ControlSourceListener>()
        this.#terminator.own(this.#field.subscribe(() => this.#valueChangeNotifier.notify(this)))
        this.#terminator.own(this.#field.pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                this.#controlSource.proxy.onControlSourceAdd(mapPointerToControlSource(pointer.pointerType))
                pointer.box.accept<BoxVisitor>({
                    visitTrackBox: (box: TrackBox) => {
                        assert(this.#trackBoxAdapter.isEmpty(), "Already assigned")
                        const adapter = this.#context.boxAdapters.adapterFor(box, TrackBoxAdapter)
                        this.#trackBoxAdapter = Option.wrap(adapter)
                        if (this.#context.isMainThread) {
                            this.#automationHandle = Option.wrap(this.#context.liveStreamReceiver
                                .subscribeFloat(this.#field.address, value => {
                                    if (this.#controlledValue === value) {return}
                                    this.#controlledValue = value
                                    this.#valueChangeNotifier.notify(this)
                                }))
                        }
                    }
                })
            },
            onRemoved: (pointer: PointerField) => {
                this.#controlSource.proxy.onControlSourceRemove(mapPointerToControlSource(pointer.pointerType))
                pointer.box.accept<BoxVisitor>({
                    visitTrackBox: (box: TrackBox) => {
                        assert(this.#trackBoxAdapter.unwrapOrNull()?.address?.equals(box.address) === true, `Unknown ${box}`)
                        this.#trackBoxAdapter = Option.None
                        if (this.#context.isMainThread) {
                            this.#automationHandle.ifSome(handle => handle.terminate())
                            this.#automationHandle = Option.None
                            this.#controlledValue = null
                            this.#valueChangeNotifier.notify(this)
                        }
                    }
                })
            }
        }, ...ExternalControlTypes))

        /*
        For debugging: It's not live because floating errors expose false positives,
            and I am too lazy to implement this in the mappings itself.
        */
        if (field.getValue() !== valueMapping.clamp(field.getValue())) {
            /*console.warn(`${name} (${field.getValue()}) is out of bounds`,
                "constraints" in field ? field["constraints"] : "no constraints",
                valueMapping, field.address.fieldKeys.join(", "), field.box.name)*/
        }
    }

    registerMidiControl(): Terminable {
        this.#controlSource.proxy.onControlSourceAdd("midi")
        this.#midiControlled = true
        return {
            terminate: () => {
                this.#midiControlled = false
                this.#controlSource.proxy.onControlSourceRemove("midi")
            }
        }
    }

    get field(): PrimitiveField<T, Pointers.Automation> {return this.#field}
    get valueMapping(): ValueMapping<T> {return this.#valueMapping}
    get stringMapping(): StringMapping<T> {return this.#stringMapping}
    get name(): string {return this.#name}
    get anchor(): unitValue {return this.#anchor}
    get type(): PrimitiveType {return this.#field.type}
    get address(): Address {return this.#field.address}
    get track(): Option<TrackBoxAdapter> {return this.#trackBoxAdapter}

    valueAt(position: ppqn): T {
        const optTrack = this.#trackBoxAdapter
        if (optTrack.nonEmpty()) {
            const track = optTrack.unwrap()
            if (track.enabled) {
                return this.valueMapping.y(track.valueAt(position, this.getUnitValue()))
            }
        }
        return this.getValue()
    }

    subscribe(observer: Observer<AutomatableParameterFieldAdapter<T>>): Subscription {
        return this.#valueChangeNotifier.subscribe(observer)
    }

    catchupAndSubscribe(observer: Observer<AutomatableParameterFieldAdapter<T>>): Subscription {
        observer(this)
        return this.subscribe(observer)
    }

    catchupAndSubscribeControlSources(observer: ControlSourceListener): Subscription {
        if (this.#midiControlled) {observer.onControlSourceAdd("midi")}
        this.#field.pointerHub.filter(...ExternalControlTypes)
            .forEach(pointer => observer.onControlSourceAdd(mapPointerToControlSource(pointer.pointerType)))
        return this.#controlSource.subscribe(observer)
    }
    getValue(): T {return this.#field.getValue()}
    setValue(value: T) {
        const previousUnitValue = this.getUnitValue()
        this.#field.setValue(value)
        this.#context.parameterFieldAdapters.notifyWrite(this, previousUnitValue)
    }
    setUnitValue(value: unitValue): void {this.setValue(this.#valueMapping.y(value))}
    getUnitValue(): unitValue {return this.#valueMapping.x(this.getValue())}
    getControlledValue(): T {return this.#valueMapping.y(this.getControlledUnitValue())}
    getControlledUnitValue(): unitValue {return this.#controlledValue ?? this.getUnitValue()}
    getControlledPrintValue(): Readonly<StringResult> {return this.#stringMapping.x(this.getControlledValue())}
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

    terminate(): void {
        this.#automationHandle.ifSome(handle => handle.terminate())
        this.#automationHandle = Option.None
        this.#terminator.terminate()
    }
}

const mapPointerToControlSource = (pointer: PointerTypes): ControlSource => {
    switch (pointer) {
        case Pointers.Automation:
            return "automated"
        case Pointers.Modulation:
            return "modulated"
        case Pointers.MIDIControl:
            return "midi"
        case Pointers.ParameterController:
            return "external"
        default:
            return panic(`${pointer.toString()} is an unknown pointer type`)
    }
}