import {asInstanceOf, isDefined, Maybe, Option, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, BoxVisitor, CaptureAudioBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {Project} from "../project"
import {Capture} from "./Capture"
import {CaptureMidi} from "./CaptureMidi"
import {CaptureAudio} from "./CaptureAudio"

type CaptureSubscription = { uuid: UUID.Bytes, subscription: Subscription }

export class CaptureDevices implements Terminable {
    readonly #project: Project
    readonly #subscription: Subscription
    readonly #captures: SortedSet<UUID.Bytes, Capture>
    readonly #captureSubscriptions: SortedSet<UUID.Bytes, CaptureSubscription>

    constructor(project: Project) {
        this.#project = project
        this.#captures = UUID.newSet<Capture>(({uuid}) => uuid)
        this.#captureSubscriptions = UUID.newSet<CaptureSubscription>(({uuid}) => uuid)
        this.#subscription = this.#project.rootBox.audioUnits.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                const uuid = box.address.uuid
                const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                const subscription = audioUnitBox.capture.catchupAndSubscribe(pointer => {
                    this.#captures.removeByKeyIfExist(uuid)?.terminate()
                    pointer.targetVertex.ifSome(({box}) => {
                        const capture: Maybe<Capture> = box.accept<BoxVisitor<Capture>>({
                            visitCaptureMidiBox: (box: CaptureMidiBox) => new CaptureMidi(this, audioUnitBox, box),
                            visitCaptureAudioBox: (box: CaptureAudioBox) => new CaptureAudio(this, audioUnitBox, box)
                        })
                        if (isDefined(capture)) {
                            this.#captures.add(capture)
                        }
                    })
                })
                this.#captureSubscriptions.add({uuid, subscription})
            },
            onRemoved: ({box: {address: {uuid}}}) => {
                this.#captures.removeByKeyIfExist(uuid)?.terminate()
                this.#captureSubscriptions.removeByKeyIfExist(uuid)?.subscription.terminate()
            }
        })
    }

    get project(): Project {return this.#project}

    get(uuid: UUID.Bytes): Option<Capture> {return this.#captures.opt(uuid)}

    setArm(subject: Capture, exclusive: boolean): void {
        const arming = !subject.armed.getValue()
        subject.armed.setValue(arming)
        if (arming && exclusive) {
            this.#captures.values()
                .filter(capture => subject !== capture)
                .forEach(capture => capture.armed.setValue(false))
        }
    }

    filterArmed(): ReadonlyArray<Capture> {
        return this.#captures.values()
            .filter(capture => capture.armed.getValue() && capture.audioUnitBox.input.pointerHub.nonEmpty())
    }

    terminate(): void {
        this.#subscription.terminate()
        this.#captures.forEach(capture => capture.terminate())
        this.#captures.clear()
    }
}