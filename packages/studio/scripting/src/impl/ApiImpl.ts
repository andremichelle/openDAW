import {Api, Project} from "../Api"
import {ProjectImpl} from "./ProjectImpl"
import {ScriptHostProtocol} from "../ScriptHostProtocol"
import {Sample} from "@moises-ai/studio-adapters"
import {ProjectUnpacker} from "../ProjectUnpacker"
import {AudioData} from "@moises-ai/lib-dsp"

export class ApiImpl implements Api {
    readonly #protocol: ScriptHostProtocol

    constructor(protocol: ScriptHostProtocol) {this.#protocol = protocol}

    newProject(name?: string): Project {
        return new ProjectImpl(this, name ?? `Scripted Project`)
    }

    async getProject(): Promise<Project> {
        const {buffer, name} = await this.#protocol.fetchProject()
        return ProjectUnpacker.unpack(this, buffer, name)
    }

    openProject(buffer: ArrayBufferLike, name?: string): void {
        this.#protocol.openProject(buffer, name)
    }

    addSample(data: AudioData, name: string): Promise<Sample> {
        return this.#protocol.addSample(data, name)
    }
}