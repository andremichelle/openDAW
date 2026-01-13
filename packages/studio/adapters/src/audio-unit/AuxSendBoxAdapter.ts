import {Address, Box, Int32Field} from "@moises-ai/lib-box"
import {
    float,
    Notifier,
    Observer,
    Option,
    StringMapping,
    Subscription,
    Terminable,
    Terminator,
    UUID,
    ValueMapping
} from "@moises-ai/lib-std"
import {AudioBusBox, AuxSendBox, BoxVisitor} from "@moises-ai/studio-boxes"
import {BoxAdapter} from "../BoxAdapter"
import {AudioBusBoxAdapter} from "./AudioBusBoxAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"

export class AuxSendBoxAdapter implements BoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: AuxSendBox

    readonly #terminator: Terminator
    readonly #busChangeNotifier: Notifier<Option<AudioBusBoxAdapter>>

    readonly #sendPan: AutomatableParameterFieldAdapter<float>
    readonly #sendGain: AutomatableParameterFieldAdapter<float>

    #subscription: Subscription = Terminable.Empty

    constructor(context: BoxAdaptersContext, box: AuxSendBox) {
        this.#context = context
        this.#box = box

        this.#terminator = new Terminator()
        this.#busChangeNotifier = this.#terminator.own(new Notifier<Option<AudioBusBoxAdapter>>())

        this.#terminator.own(box.targetBus.catchupAndSubscribe(() => {
            this.#subscription.terminate()
            this.#subscription = this.optTargetBus.match({
                none: () => {
                    this.#busChangeNotifier.notify(Option.None)
                    return Terminable.Empty
                },
                some: adapter => adapter.catchupAndSubscribe(adapter => this.#busChangeNotifier.notify(Option.wrap(adapter)))
            })
        }))

        this.#sendPan = this.#terminator.own(new AutomatableParameterFieldAdapter<float>(this.#context, this.#box.sendPan,
            ValueMapping.bipolar(),
            StringMapping.percent({unit: "%", fractionDigits: 0}), "panning"))

        this.#sendGain = this.#terminator.own(new AutomatableParameterFieldAdapter<float>(this.#context, this.#box.sendGain, ValueMapping.DefaultDecibel,
            StringMapping.numeric({
                unit: "dB",
                fractionDigits: 1
            }), "gain"))
    }

    catchupAndSubscribeBusChanges(observer: Observer<Option<AudioBusBoxAdapter>>): Subscription {
        observer(this.optTargetBus)
        return this.#busChangeNotifier.subscribe(observer)
    }

    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get box(): Box {return this.#box}
    get indexField(): Int32Field {return this.#box.index}
    get sendPan(): AutomatableParameterFieldAdapter<float> {return this.#sendPan}
    get sendGain(): AutomatableParameterFieldAdapter<float> {return this.#sendGain}
    get targetBus(): AudioBusBoxAdapter {
        return this.#context.boxAdapters
            .adapterFor(this.#box.targetBus.targetVertex.unwrap("no audioUnit").box, AudioBusBoxAdapter)
    }

    get optTargetBus(): Option<AudioBusBoxAdapter> {
        return this.#box.targetBus.targetVertex
            .flatMap(target => Option.wrap(target.box.accept<BoxVisitor<AudioBusBoxAdapter>>({
                visitAudioBusBox: (box: AudioBusBox) => this.#context.boxAdapters.adapterFor(box, AudioBusBoxAdapter)
            })))
    }

    delete(): void {this.#box.delete()}

    terminate(): void {
        this.#terminator.terminate()
        this.#subscription.terminate()
    }
}