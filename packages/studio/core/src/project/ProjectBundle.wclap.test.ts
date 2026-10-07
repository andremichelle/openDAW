// @vitest-environment node
import {afterEach, describe, expect, it, vi} from "vitest"
import JSZip from "jszip"
import {Option, panic, Terminable, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

const files = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            exists: async (path: string) => files.has(path),
            read: async (path: string) => {
                const bytes = files.get(path)
                if (bytes === undefined) {throw new Error(`NotFound ${path}`)}
                return bytes
            },
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())}
        }
    }
}))

import type {ProjectEnv} from "./ProjectEnv"
import {ProjectBundle} from "./ProjectBundle"
import {ProjectProfile} from "./ProjectProfile"
import {ProjectMeta} from "./ProjectMeta"
import {EffectFactories} from "../EffectFactories"
import {WclapStorage} from "../wclap/WclapStorage"

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const profileWithWclaps = async (urls: ReadonlyArray<string>): Promise<ProjectProfile> => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    project.boxGraph.beginTransaction()
    urls.forEach(url => {
        const device = EffectFactories.AudioNamed.Wclap.create(project, skeleton.mandatoryBoxes.primaryAudioUnitBox.audioEffects, 0)
        if (!(device instanceof WclapDeviceBox)) {return panic("expected a WclapDeviceBox")}
        device.url.setValue(url)
        device.clapId.setValue("uk.co.signalsmith.basics.reverb")
    })
    project.boxGraph.endTransaction()
    return new ProjectProfile(UUID.generate(), project, ProjectMeta.init(), Option.None)
}

const wclapEntries = async (bundle: ArrayBuffer): Promise<Array<string>> =>
    Object.keys((await JSZip.loadAsync(bundle)).files).filter(path => path.startsWith(`${WclapStorage.Folder}/`) && !path.endsWith("/"))

describe("ProjectBundle with WebCLAP bundles", () => {
    afterEach(() => files.clear())

    it("includes every stored bundle", async () => {
        const url = await WclapStorage.store(new Uint8Array(64).fill(7).buffer)
        const bundle = await ProjectBundle.encode(await profileWithWclaps([url]), () => {})
        expect(await wclapEntries(bundle)).toStrictEqual([`${WclapStorage.pathOf(WclapStorage.idOf(url))}`])
    })

    it("imports a bundle from an .odb as freshly stored", async () => {
        vi.useFakeTimers({toFake: ["Date"], now: 5000})
        const url = await WclapStorage.store(new Uint8Array(64).fill(7).buffer)
        const bundle = await ProjectBundle.encode(await profileWithWclaps([url]), () => {})
        files.clear()
        vi.setSystemTime(9000)
        await ProjectBundle.decode(createEnv(), bundle)
        const id = WclapStorage.idOf(url)
        expect(await WclapStorage.exists(id)).toBe(true)
        expect(await WclapStorage.storedAt(id)).toBe(9000)
        vi.useRealTimers()
    })

    it("exports the project without a bundle that is not stored", async () => {
        const stored = await WclapStorage.store(new Uint8Array(64).fill(7).buffer)
        const missing = await WclapStorage.urlFor(new Uint8Array(64).fill(9).buffer)
        const bundle = await ProjectBundle.encode(await profileWithWclaps([stored, missing]), () => {})
        expect(await wclapEntries(bundle)).toStrictEqual([`${WclapStorage.pathOf(WclapStorage.idOf(stored))}`])
    })
})
