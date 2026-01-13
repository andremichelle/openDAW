import {AudioFileBox} from "@moises-ai/studio-boxes"
import {UUID} from "@moises-ai/lib-std"
import {BoxGraph} from "@moises-ai/lib-box"

export namespace AudioFileBoxfactory {
    export const create = (boxGraph: BoxGraph, sample: Sample): AudioFileBox =>
        AudioFileBox.create(boxGraph, UUID.parse(sample.uuid), box => {
            box.fileName.setValue(sample.name)
            box.startInSeconds.setValue(0)
            box.endInSeconds.setValue(sample.duration)
        })
}