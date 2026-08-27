import {AudioData} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {isDefined, isNull, panic} from "@opendaw/lib-std"
import {Api, Project, Sample} from "../Api"
import {ScriptHostProtocol} from "../ScriptHostProtocol"
import {ProjectImpl} from "./ProjectImpl"
import {Guard} from "./Guard"

export class ApiImpl implements Api {
    readonly #protocol: ScriptHostProtocol

    constructor(protocol: ScriptHostProtocol) {this.#protocol = protocol}

    newProject(name?: string): Project {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        return new ProjectImpl(this.#protocol, skeleton, isDefined(name) ? Guard.string(name, "name") : "Scripted Project")
    }

    hasProject(): Promise<boolean> {return this.#protocol.hasProject()}

    showInfo(headline: string, message: string): Promise<void> {
        return this.#protocol.showInfo(Guard.string(headline, "headline"), Guard.string(message, "message"))
    }

    async getProject(): Promise<Project> {
        const {buffer, name} = await this.#protocol.fetchProject()
        const project = new ProjectImpl(this.#protocol, ProjectSkeleton.decode(buffer), name)
        project.context.startRecording()
        return project
    }

    async addSample(data: AudioData, name: string): Promise<Sample> {
        if (typeof data !== "object" || isNull(data) || !Array.isArray(data.frames)) {
            return panic(new TypeError("addSample: expected AudioData"))
        }
        if (!(data.numberOfFrames > 0)) {return panic(new RangeError("addSample: audio data is empty"))}
        return this.#protocol.addSample(data, Guard.string(name, "name"))
    }

    listSamples(): Promise<ReadonlyArray<Sample>> {return this.#protocol.listSamples()}
}
