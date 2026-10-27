import {RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox, TransientMarkerBox} from "@opendaw/studio-boxes"
import {AudioFileBoxAdapter} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {Project} from "./project"
import {SampleService} from "./samples"

export namespace AudioMonoConversion {
    export type Mode = "sum" | "equal-power"

    export const canConvert = (file: AudioFileBoxAdapter): boolean =>
        file.data.mapOr(data => data.numberOfChannels > 1, false)

    export const mixdown = (audioData: AudioData, mode: Mode): AudioData => {
        const {sampleRate, numberOfFrames, numberOfChannels, frames} = audioData
        const gain = mode === "sum" ? 1.0 : 1.0 / Math.sqrt(numberOfChannels)
        const mono = AudioData.create(sampleRate, numberOfFrames, 1)
        const target = mono.frames[0]
        for (const source of frames) {
            for (let index = 0; index < numberOfFrames; index++) {target[index] += source[index] * gain}
        }
        return mono
    }

    export const replace = (project: Project, original: AudioFileBox, uuid: UUID.Bytes,
                            keepOriginal: boolean): AudioFileBox => {
        const {boxGraph} = project
        const target = boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() =>
            AudioFileBox.create(boxGraph, uuid, box => {
                box.fileName.setValue(original.fileName.getValue())
                box.startInSeconds.setValue(original.startInSeconds.getValue())
                box.endInSeconds.setValue(original.endInSeconds.getValue())
            }))
        if (target.transientMarkers.pointerHub.isEmpty()) {
            original.transientMarkers.pointerHub.incoming()
                .map(pointer => pointer.box)
                .filter(box => box instanceof TransientMarkerBox)
                .forEach(marker => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.owner.refer(target.transientMarkers)
                    box.position.setValue(marker.position.getValue())
                }))
        }
        original.incomingEdges()
            .filter(pointer => pointer.pointerType === Pointers.AudioFile)
            .forEach(pointer => pointer.refer(target))
        if (keepOriginal) {
            project.untrackUserCreatedSample(original.address.uuid)
        } else {
            project.trackUserCreatedSample(original.address.uuid)
        }
        project.trackUserCreatedSample(uuid)
        original.delete()
        return target
    }

    export const convert = async (project: Project, sampleService: SampleService, file: AudioFileBoxAdapter,
                                  mode: Mode, keepOriginal: boolean): Promise<void> => {
        const progress = RuntimeNotifier.progress({headline: "Converting to Mono...", message: file.fileName})
        const {status, value: sample, error} = await Promises.tryCatch((async () => {
            const audioData = await file.audioData
            const bpm = file.getOrCreateLoader().meta.mapOr(meta => meta.bpm, 0)
            return sampleService.importFile({
                name: file.fileName,
                bpm,
                arrayBuffer: WavFile.encodeFloats(mixdown(audioData, mode))
            })
        })())
        progress.terminate()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Convert to Mono failed.", icon: "Warning"})
            return
        }
        project.editing.modify(() => replace(project, file.box, UUID.parse(sample.uuid), keepOriginal))
    }
}
