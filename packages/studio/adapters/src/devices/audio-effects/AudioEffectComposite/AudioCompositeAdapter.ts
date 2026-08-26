import {Option, StringMapping, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Field, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {AudioEffectCompositeBox, FrequencySplitBox, StereoCompositeBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../../DeviceAdapter"
import {LabeledAudioOutput} from "../../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../../BoxAdaptersContext"
import {IndexedBoxAdapterCollection} from "../../../IndexedBoxAdapterCollection"
import {ParameterAdapterSet} from "../../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../../audio-unit/AudioUnitBoxAdapter"
import {AudioEffectCompositeCellBoxAdapter} from "./AudioEffectCompositeCellBoxAdapter"

// The two audio composites share ONE field layout (entries 10, input 11, dry 12, wet 13) and one entry type; they
// differ only in how the engine DISTRIBUTES the input to the entries (broadcast vs per-channel split), which the
// engine selects by box type. So the adapter behaviour lives here once.
export type AudioCompositeBox = AudioEffectCompositeBox | StereoCompositeBox | FrequencySplitBox

// A parallel audio composite: hosts AudioEffectCompositeCellBox ENTRIES, each its own audio-fx chain, mixed through
// their own gain / mute / solo into the wet sum, and blended with the dry input by `dry` / `wet`.
export abstract class AudioCompositeAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

    // Whether the ENTRY set is fixed by the device (a stereo split owns exactly its L / R entries and the UI
    // offers no add / remove / reorder), as opposed to a user-managed stack.
    abstract get entriesFixed(): boolean
    abstract get manualUrl(): string

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioCompositeBox

    readonly #entries: IndexedBoxAdapterCollection<AudioEffectCompositeCellBoxAdapter, Pointers.AudioEffectCompositeCell>

    readonly #parametric: ParameterAdapterSet
    readonly namedParameter // let typescript infer the type

    protected constructor(context: BoxAdaptersContext, box: AudioCompositeBox) {
        this.#context = context
        this.#box = box
        this.#entries = this.#terminator.own(IndexedBoxAdapterCollection.create(this.#box.entries,
            box => this.#context.boxAdapters.adapterFor(box, AudioEffectCompositeCellBoxAdapter),
            Pointers.AudioEffectCompositeCell))
        this.#parametric = this.#terminator.own(new ParameterAdapterSet(this.#context))
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): AudioCompositeBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    get entries(): IndexedBoxAdapterCollection<AudioEffectCompositeCellBoxAdapter, Pointers.AudioEffectCompositeCell> {
        return this.#entries
    }

    // The composite's INPUT TAP: the address a device nested inside this composite points its sidechain at to
    // detect the signal ENTERING the composite (see AudioEffectCompositeBox field 11).
    get inputField(): Field<Pointers.SideChain> {return this.#box.input}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        // Only the composite's MIXED output is a public sidechain source. Its ENTRIES are internal — surfacing
        // them cluttered every sidechain picker with blank rows, and a device outside the composite has no
        // reason to tap one branch. (The composite's INPUT is offered separately, and only to the devices
        // INSIDE it — see SidechainButton.)
        yield {
            address: this.address,
            label: this.labelField.getValue(),
            children: () => Option.None
        }
    }

    terminate(): void {this.#terminator.terminate()}

    #wrapParameters(box: AudioCompositeBox) {
        return {
            dry: this.#parametric.createParameter(box.dry, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Dry"),
            wet: this.#parametric.createParameter(box.wet, ValueMapping.DefaultDecibel,
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Wet")
        } as const
    }
}
