import {
    DefaultObservableValue,
    MappedMutableObservableValue,
    MutableObservableValue,
    Option,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {AudioUnitBox} from "@moises-ai/studio-boxes"
import {AnyRegionBox, CaptureBox} from "@moises-ai/studio-adapters"
import {CaptureDevices} from "./CaptureDevices"

export abstract class Capture<BOX extends CaptureBox = CaptureBox> implements Terminable {
    readonly #terminator = new Terminator()

    readonly #manager: CaptureDevices
    readonly #audioUnitBox: AudioUnitBox
    readonly #captureBox: BOX

    readonly #deviceId: MutableObservableValue<Option<string>>
    readonly #armed: DefaultObservableValue<boolean>
    readonly #recordedRegions: Array<AnyRegionBox> = []

    protected constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureBox: BOX) {
        this.#manager = manager
        this.#audioUnitBox = audioUnitBox
        this.#captureBox = captureBox

        this.#deviceId = new MappedMutableObservableValue<string, Option<string>>(captureBox.deviceId, {
            fx: x => x.length > 0 ? Option.wrap(x) : Option.None,
            fy: y => y.match({none: () => "", some: x => x})
        })

        this.#armed = this.#terminator.own(new DefaultObservableValue(false))
        this.#terminator.ownAll(
            this.#captureBox.deviceId.catchupAndSubscribe(owner => {
                const id = owner.getValue()
                this.#deviceId.setValue(id.length > 0 ? Option.wrap(id) : Option.None)
            })
        )
    }

    abstract get label(): string
    abstract get deviceLabel(): Option<string>
    abstract prepareRecording(): Promise<void>
    abstract startRecording(): Terminable

    get uuid(): UUID.Bytes {return this.#audioUnitBox.address.uuid}
    get manager(): CaptureDevices {return this.#manager}
    get audioUnitBox(): AudioUnitBox {return this.#audioUnitBox}
    get captureBox(): BOX {return this.#captureBox}
    get armed(): MutableObservableValue<boolean> {return this.#armed}
    get deviceId(): MutableObservableValue<Option<string>> {return this.#deviceId}

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}
    ownAll<T extends Terminable>(...terminables: ReadonlyArray<T>): void {this.#terminator.ownAll(...terminables)}
    terminate(): void {this.#terminator.terminate()}

    addRecordedRegion(region: AnyRegionBox): void {this.#recordedRegions.push(region)}
    recordedRegions(): ReadonlyArray<AnyRegionBox> {return this.#recordedRegions}
    clearRecordedRegions(): void {this.#recordedRegions.length = 0}
}