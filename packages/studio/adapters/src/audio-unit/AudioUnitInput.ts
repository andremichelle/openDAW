import {
    assert,
    DefaultObservableValue,
    MutableObservableOption,
    Notifier,
    ObservableOption,
    ObservableValue,
    Observer,
    Option,
    panic,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {PointerHub} from "@opendaw/lib-box"
import {AudioBusBox} from "@opendaw/studio-boxes"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioUnitInputAdapter} from "./AudioUnitInputAdapter"
import {BoxAdapters} from "../BoxAdapters"
import {AudioBusBoxAdapter} from "./AudioBusBoxAdapter"
import {Devices} from "../DeviceAdapter"

export class AudioUnitInput implements Terminable {
    readonly #terminator: Terminator
    readonly #labelNotifier: Notifier<Option<string>>
    readonly #iconValue: DefaultObservableValue<IconSymbol>
    readonly #adapter: MutableObservableOption<AudioUnitInputAdapter>

    #subscription: Subscription = Terminable.Empty

    constructor(pointerHub: PointerHub, boxAdapters: BoxAdapters) {
        this.#terminator = new Terminator()
        this.#labelNotifier = this.#terminator.own(new Notifier<Option<string>>())
        this.#iconValue = this.#terminator.own(new DefaultObservableValue<IconSymbol>(IconSymbol.Unknown))
        this.#adapter = this.#terminator.own(new MutableObservableOption<AudioUnitInputAdapter>())
        this.#terminator.own(this.#adapter.subscribe(owner => {
            this.#subscription.terminate()
            this.#subscription = owner.match({
                none: () => {
                    this.#labelNotifier.notify(Option.None)
                    return Terminable.Empty
                },
                some: ({labelField, iconField}) => Terminable.many(
                    iconField.catchupAndSubscribe(field => this.#iconValue.setValue(IconSymbol.fromName(field.getValue()))),
                    labelField.catchupAndSubscribe(field => this.#labelNotifier.notify(Option.wrap(field.getValue())))
                )
            })
        }))
        this.#terminator.own(pointerHub.catchupAndSubscribe({
            onAdded: ({box, pointerType}) => {
                if (this.#adapter.nonEmpty()) {
                    const existing = this.#adapter.unwrap()
                    panic(`AudioUnitInput already has an input. ` +
                        `Existing: ${existing.box.name}@${existing.box.address.toString()} (type: ${existing.type}), ` +
                        `Incoming: ${box.name}@${box.address.toString()} (pointerType: ${String(pointerType)})`)
                }
                const input: AudioUnitInputAdapter = box instanceof AudioBusBox
                    ? boxAdapters.adapterFor(box, AudioBusBoxAdapter)
                    : boxAdapters.adapterFor(box, Devices.isInstrument)
                if (this.#adapter.unwrapOrNull() !== input) {
                    this.#adapter.wrap(input)
                }
            },
            onRemoved: ({box}) => {
                assert(this.#adapter.unwrap("Cannot remove").box.address
                    .equals(box.address), "Unexpected value to remove")
                this.#adapter.clear()
            }
        }, Pointers.InstrumentHost, Pointers.AudioOutput))
    }

    adapter(): ObservableOption<AudioUnitInputAdapter> {return this.#adapter}

    subscribe(observer: Observer<Option<AudioUnitInputAdapter>>): Terminable {
        return this.#adapter.subscribe(observer)
    }

    catchupAndSubscribe(observer: Observer<Option<AudioUnitInputAdapter>>): Terminable {
        observer(this.#adapter)
        return this.subscribe(observer)
    }

    catchupAndSubscribeLabelChange(observer: Observer<Option<string>>): Terminable {
        observer(this.label)
        return this.#labelNotifier.subscribe(observer)
    }

    catchupAndSubscribeIconChange(observer: Observer<ObservableValue<IconSymbol>>): Terminable {
        return this.#iconValue.catchupAndSubscribe(observer)
    }

    set label(value: string) {this.adapter().ifSome(input => input.labelField.setValue(value))}
    get label(): Option<string> {return this.adapter().map(input => input.labelField.getValue())}

    set icon(value: IconSymbol) {this.adapter().ifSome(input => input.iconField.setValue(IconSymbol.toName(value)))}
    get icon(): IconSymbol {
        return this.adapter().match({
            none: () => IconSymbol.Unknown,
            some: input => IconSymbol.fromName(input.iconField.getValue())
        })
    }

    get iconValue(): DefaultObservableValue<IconSymbol> {return this.#iconValue}

    terminate(): void {
        this.#terminator.terminate()
        this.#subscription.terminate()
    }
}