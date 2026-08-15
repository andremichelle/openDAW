import {
    assert,
    clamp,
    ControlSource,
    ControlSourceListener,
    isNull,
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
import {AudioUnitTracks} from "./audio-unit/AudioUnitTracks"
import {BoxAdaptersContext} from "./BoxAdaptersContext"

const ExternalControlTypes = [
    Pointers.Automation,
    Pointers.Modulation,
    Pointers.MIDIControl,
    Pointers.ParameterController] as const

export class AutomatableParameterFieldAdapter<T extends PrimitiveValues = any> implements Parameter<T>, Terminable {
    readonly #context: BoxAdaptersContext
    readonly #field: PrimitiveField<T, Pointers.Automation>
    readonly #name: string
    readonly #anchor: unitValue
    readonly #resetValue: Option<T>

    readonly #terminator: Terminator = new Terminator()
    readonly #valueChangeNotifier: Notifier<this>
    readonly #controlSource: Listeners<ControlSourceListener>

    #valueMapping: ValueMapping<T>
    #stringMapping: StringMapping<T>

    #trackBoxAdapter: Option<TrackBoxAdapter> = Option.None
    #automationHandle: Option<Terminable> = Option.None
    #controlledValue: Nullable<unitValue> = null
    #modulationValue: Nullable<unitValue> = null
    #midiControlled: boolean = false

    constructor(context: BoxAdaptersContext,
                field: PrimitiveField<T, any>,
                valueMapping: ValueMapping<T>,
                stringMapping: StringMapping<T>,
                name: string,
                anchor?: unitValue,
                resetValue?: T) {
        this.#context = context
        this.#field = field
        this.#valueMapping = valueMapping
        this.#stringMapping = stringMapping
        this.#name = name
        this.#anchor = anchor ?? 0.0
        this.#resetValue = Option.wrap(resetValue)
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
                        this.#trackBoxAdapter = Option.wrap(this.#context.boxAdapters.adapterFor(box, TrackBoxAdapter))
                    }
                })
                this.#observeEngineValue()
            },
            onRemoved: (pointer: PointerField) => {
                this.#controlSource.proxy.onControlSourceRemove(mapPointerToControlSource(pointer.pointerType))
                pointer.box.accept<BoxVisitor>({
                    visitTrackBox: (box: TrackBox) => {
                        assert(this.#trackBoxAdapter.unwrapOrNull()?.address?.equals(box.address) === true, `Unknown ${box}`)
                        this.#trackBoxAdapter = Option.None
                    }
                })
                this.#releaseEngineValue()
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

    // The engine broadcasts TWO floats at the parameter's field address while automation or modulation applies:
    // [0] the automated unit value, [1] the summed modulation in normalized space. NaN is its "does not apply"
    // sentinel in both slots — automation attached with no region / clip / events yet, or no enabled
    // assignment — and the parameter then falls back to its own storage value (a real 0 would read as unit 0
    // and pin the knob to its minimum). Bound while ANY external control source is attached, since a
    // modulation applies with no automation track at all.
    #observeEngineValue(): void {
        if (!this.#context.isMainThread || this.#automationHandle.nonEmpty()) {return}
        this.#automationHandle = Option.wrap(this.#context.liveStreamReceiver
            .subscribeFloats(this.#field.address, values => {
                const automated: Nullable<unitValue> = isNaN(values[0]) ? null : values[0]
                const modulation: Nullable<unitValue> = isNaN(values[1]) ? null : values[1]
                if (this.#controlledValue === automated && this.#modulationValue === modulation) {return}
                this.#controlledValue = automated
                this.#modulationValue = modulation
                this.#valueChangeNotifier.notify(this)
            }))
    }

    #releaseEngineValue(): void {
        if (!this.#context.isMainThread || this.#field.pointerHub.filter(...ExternalControlTypes).length > 0) {return}
        this.#automationHandle.ifSome(handle => handle.terminate())
        this.#automationHandle = Option.None
        this.#controlledValue = null
        this.#modulationValue = null
        this.#valueChangeNotifier.notify(this)
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

    registerTracks(tracks: AudioUnitTracks): Terminable {
        return this.#context.parameterFieldAdapters.registerTracks(this.address, tracks)
    }
    touchStart(): void {
        this.#context.parameterFieldAdapters.touchStart(this.address)
        this.#context.parameterFieldAdapters.notifyWrite(this, this.getUnitValue())
    }
    touchEnd(): void {this.#context.parameterFieldAdapters.touchEnd(this.address)}

    updateMappings(valueMapping: ValueMapping<T>, stringMapping: StringMapping<T>): void {
        this.#valueMapping = valueMapping
        this.#stringMapping = stringMapping
        this.#valueChangeNotifier.notify(this)
    }

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
        if (value === this.getValue()) {return}
        const previousUnitValue = this.getUnitValue()
        this.#field.setValue(value)
        this.#context.parameterFieldAdapters.notifyWrite(this, previousUnitValue)
    }
    setUnitValue(value: unitValue): void {this.setValue(this.#valueMapping.y(value))}
    getUnitValue(): unitValue {return this.#valueMapping.x(this.getValue())}
    getControlledValue(): T {return this.#valueMapping.y(this.getControlledUnitValue())}
    // base (the automated value, else the storage value) + the summed modulation, clamped — the modulation
    // formula, on the UI side of it. The engine cannot compute this itself for an unautomated parameter: it
    // holds the storage value in the parameter's real unit and the mapping lives here (and in the device).
    getControlledUnitValue(): unitValue {
        const base = this.#controlledValue ?? this.getUnitValue()
        return isNull(this.#modulationValue) ? base : clamp(base + this.#modulationValue, 0.0, 1.0)
    }
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

    reset(): void {this.setValue(this.#resetValue.unwrapOrElse(this.#field.initValue))}

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