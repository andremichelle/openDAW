import {Box, BoxGraph, PointerField} from "@opendaw/lib-box"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {isDefined, isNull, Nullable, panic, Provider, tryCatch, UUID} from "@opendaw/lib-std"
import {Sample, SoundfontFile} from "../Api"
import {Guard} from "./Guard"
import {Context} from "./Context"

export namespace AudioFiles {
    export const validate = (sample: unknown, name: string = "sample"): Sample => {
        if (!isDefined(sample) || typeof sample !== "object") {
            return panic(new TypeError(`${name}: expected a Sample, got ${Guard.describe(sample)}`))
        }
        const {uuid, name: fileName, duration} = sample as Partial<Sample>
        const parsed = tryCatch(() => UUID.parse(Guard.string(uuid, `${name}.uuid`)))
        if (parsed.status === "failure") {return panic(new TypeError(`${name}.uuid: '${uuid}' is not a valid uuid`))}
        Guard.string(fileName, `${name}.name`)
        if (!(Guard.number(duration, `${name}.duration`) > 0.0)) {
            return panic(new RangeError(`${name}.duration: must be positive, got ${duration}`))
        }
        return sample as Sample
    }

    export const use = (context: Context, sample: Sample): AudioFileBox => {
        const validated = validate(sample)
        context.samples.set(validated.uuid, validated)
        const uuid = UUID.parse(validated.uuid)
        return context.boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() =>
            AudioFileBox.create(context.boxGraph, uuid, box => {
                box.fileName.setValue(validated.name)
                box.startInSeconds.setValue(0.0)
                box.endInSeconds.setValue(validated.duration)
            }))
    }

    export const toSample = (context: Context, box: AudioFileBox): Sample => {
        const uuid = UUID.toString(box.address.uuid)
        const known = context.samples.get(uuid)
        if (isDefined(known)) {return known}
        const sample: Sample = {
            uuid,
            name: box.fileName.getValue(),
            duration: box.endInSeconds.getValue() - box.startInSeconds.getValue(),
            bpm: 0,
            sample_rate: 0
        }
        context.samples.set(uuid, sample)
        return sample
    }

    export const useSoundfont = (boxGraph: BoxGraph, file: SoundfontFile): SoundfontFileBox => {
        const parsed = tryCatch(() => UUID.parse(Guard.string(file?.uuid, "soundfont.uuid")))
        if (parsed.status === "failure") {return panic(new TypeError(`soundfont.uuid: '${file.uuid}' is not a valid uuid`))}
        const name = Guard.string(file.name, "soundfont.name")
        return boxGraph.findBox<SoundfontFileBox>(parsed.value)
            .unwrapOrElse(() => SoundfontFileBox.create(boxGraph, parsed.value, box => box.fileName.setValue(name)))
    }

    export const toSoundfont = (box: SoundfontFileBox): SoundfontFile =>
        ({uuid: UUID.toString(box.address.uuid), name: box.fileName.getValue()})

    // File boxes demand at least one referrer, so an unreferenced one is deleted with the last pointer.
    export const assign = (context: Context, pointer: PointerField, provider: Provider<Nullable<Box>>): void =>
        context.edit(() => {
            const previous = pointer.targetVertex.mapOr(vertex => vertex.box, null)
            const target = provider()
            if (isNull(target)) {
                pointer.defer()
            } else {
                pointer.refer(target)
            }
            if (!isNull(previous) && previous !== target && previous.pointerHub.size() === 0) {previous.delete()}
        })
}
