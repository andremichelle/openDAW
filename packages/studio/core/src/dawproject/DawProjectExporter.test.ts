import {describe, it} from "vitest"
import {fileURLToPath} from "url"
import * as path from "node:path"
import * as fs from "node:fs"
import {
    ProjectSkeleton,
    SampleLoader,
    SampleLoaderManager,
    SampleLoaderState
} from "@moises-ai/studio-adapters"
import {Observer, Option, panic, Subscription, Terminable, UUID} from "@moises-ai/lib-std"
import {Xml} from "@moises-ai/lib-xml"
import {FileReferenceSchema} from "@moises-ai/lib-dawproject"
import {DawProjectExporter} from "./DawProjectExporter"
import {Peaks} from "@moises-ai/lib-fusion"
import {AudioData} from "@moises-ai/lib-dsp"

describe("DawProjectExport", () => {
    it("export", async () => {
        const __dirname = path.dirname(fileURLToPath(import.meta.url))
        const projectPath = "../../../../../test-files/all-devices.od"
        const buffer = fs.readFileSync(path.join(__dirname, projectPath))
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        const sampleManager = new class implements SampleLoaderManager {
            record(_loader: SampleLoader & { uuid: UUID.Bytes }): void {
                throw new Error("Method not implemented.")
            }
            getOrCreate(format: UUID.Bytes): SampleLoader {
                return new class implements SampleLoader {
                    data: Option<AudioData> = Option.None
                    peaks: Option<Peaks> = Option.None
                    uuid: UUID.Bytes = format
                    state: SampleLoaderState = {type: "progress", progress: 0.0}
                    meta: Option<any> = Option.None
                    invalidate(): void {throw new Error("Method not implemented.")}
                    subscribe(_observer: Observer<SampleLoaderState>): Subscription {
                        return Terminable.Empty
                    }
                }
            }
            remove(_uuid: UUID.Bytes): void {return panic("Method not implemented.")}
            invalidate(_uuid: UUID.Bytes): void {return panic("Method not implemented.")}
            register(_uuid: UUID.Bytes): Terminable {return Terminable.Empty}
        }
        const skeleton = ProjectSkeleton.decode(arrayBuffer)
        const schema = DawProjectExporter.write(skeleton, sampleManager, {
            write: (path: string, buffer: ArrayBufferLike): FileReferenceSchema => {
                console.debug(`store ${buffer.byteLength} bytes at ${path}`)
                return Xml.element({path, external: false}, FileReferenceSchema)
            }
        })
        // console.dir(schema, {depth: Number.MAX_SAFE_INTEGER})
        console.debug(Xml.pretty(Xml.toElement("Project", schema)))
    })
})