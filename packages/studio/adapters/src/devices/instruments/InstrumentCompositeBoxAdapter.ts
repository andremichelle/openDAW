import {InstrumentCompositeBox} from "@opendaw/studio-boxes"
import {Address, BooleanField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Option, UUID} from "@opendaw/lib-std"
import {DeviceHost, Devices, InstrumentDeviceBoxAdapter} from "../../DeviceAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {IndexedBoxAdapterCollection} from "../../IndexedBoxAdapterCollection"
import {TrackType} from "../../timeline/TrackType"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {InstrumentCompositeCellBoxAdapter} from "./InstrumentComposite/InstrumentCompositeCellBoxAdapter"

export class InstrumentCompositeBoxAdapter implements InstrumentDeviceBoxAdapter {
    readonly type = "instrument"
    readonly accepts = "midi"
    readonly manualUrl = DeviceManualUrls.InstrumentComposite

    readonly #context: BoxAdaptersContext
    readonly #box: InstrumentCompositeBox

    readonly #cells: IndexedBoxAdapterCollection<InstrumentCompositeCellBoxAdapter, Pointers.InstrumentCompositeCell>

    constructor(context: BoxAdaptersContext, box: InstrumentCompositeBox) {
        this.#context = context
        this.#box = box
        this.#cells = IndexedBoxAdapterCollection.create(box.cells,
            box => context.boxAdapters.adapterFor(box, InstrumentCompositeCellBoxAdapter), Pointers.InstrumentCompositeCell)
    }

    get box(): InstrumentCompositeBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): StringField {return this.#box.label}
    get iconField(): StringField {return this.#box.icon}
    get defaultTrackType(): TrackType {return TrackType.Notes}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get acceptsMidiEvents(): boolean {return true}
    get cells(): IndexedBoxAdapterCollection<InstrumentCompositeCellBoxAdapter, Pointers.InstrumentCompositeCell> {return this.#cells}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
        for (const cell of this.#cells.adapters()) {
            yield {address: cell.address, label: cell.label, children: () => Option.wrap(cell.labeledAudioOutputs())}
        }
    }

    terminate(): void {this.#cells.terminate()}
}
