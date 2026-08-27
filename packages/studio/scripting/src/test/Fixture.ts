import {AudioData} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {applyUpdateTasks, BoxGraph, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {Arrays, Option, UUID} from "@opendaw/lib-std"
import {Api, Project, Sample} from "../Api"
import {ScriptHostProtocol} from "../ScriptHostProtocol"
import {ApiImpl} from "../impl/ApiImpl"
import {ProjectImpl} from "../impl/ProjectImpl"

export class FakeHost implements ScriptHostProtocol {
    readonly opened: Array<{ buffer: ArrayBufferLike, name: string }> = []
    readonly samples: Array<Sample> = []
    readonly dialogs: Array<{ headline: string, message: string }> = []
    readonly applied: Array<ReadonlyArray<UpdateTask<BoxIO.TypeMap>>> = []
    current: { graph: BoxGraph<BoxIO.TypeMap>, name: string } | null = null

    async hasProject(): Promise<boolean> {return this.current !== null}
    async showInfo(headline: string, message: string): Promise<void> {this.dialogs.push({headline, message})}

    openProject(buffer: ArrayBufferLike, name?: string): void {
        this.opened.push({buffer, name: name ?? ""})
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.fromArrayBuffer(buffer, false)
        this.current = {graph, name: name ?? ""}
    }
    applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void {
        if (this.current === null) {throw new Error("No project")}
        const {graph} = this.current
        if (!Arrays.equals(graph.checksum(), checksum)) {throw new Error("Checksum mismatch")}
        graph.beginTransaction()
        applyUpdateTasks(graph, updates)
        graph.endTransaction()
        this.applied.push(updates)
    }
    async fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }> {
        if (this.current === null) {throw new Error("No project")}
        return {buffer: ProjectSkeleton.encode(this.current.graph) as ArrayBuffer, name: this.current.name}
    }
    async addSample(data: AudioData, name: string): Promise<Sample> {
        const sample: Sample = {
            uuid: UUID.toString(UUID.generate()), name, duration: data.numberOfFrames / data.sampleRate,
            bpm: 0, sample_rate: data.sampleRate
        }
        this.samples.push(sample)
        return sample
    }
    async listSamples(): Promise<ReadonlyArray<Sample>> {return this.samples}
}

export const createFixture = (): { api: Api, host: FakeHost, project: Project } => {
    const host = new FakeHost()
    const api = new ApiImpl(host)
    const project = api.newProject("Test")
    return {api, host, project}
}

export const sample = (name: string = "Kick", duration: number = 1.0, bpm: number = 0): Sample =>
    ({uuid: UUID.toString(UUID.generate()), name, duration, bpm, sample_rate: 48000})

export const impl = (project: Project): ProjectImpl => project as ProjectImpl
