import {Project} from "./Api"
import {ProjectSkeleton} from "@moises-ai/studio-adapters"
import {ApiImpl, ProjectImpl} from "./impl"

export namespace ProjectUnpacker {
    export const unpack = (api: ApiImpl, buffer: ArrayBufferLike, name: string): Project => {
        const {boxGraph, mandatoryBoxes: {timelineBox}} = ProjectSkeleton.decode(buffer)
        const project = new ProjectImpl(api, name)

        project.bpm = timelineBox.bpm.getValue()
        project.timeSignature.numerator = timelineBox.signature.nominator.getValue()
        project.timeSignature.denominator = timelineBox.signature.denominator.getValue()

        // TODO
        return project
    }
}