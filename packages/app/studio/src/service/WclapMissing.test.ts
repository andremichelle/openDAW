import {afterAll, beforeAll, describe, expect, it, vi} from "vitest"
import {RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {WclapDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {WclapStorage} from "@opendaw/studio-core"
import {OpenWclapAPI} from "@/opendaw-api"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {WclapMissing} from "./WclapMissing"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

// A project pinned to a build that a newer one superseded: the index lists only the newer build, the old file stays
// on the server. A machine without a local copy must get the old build back, never the browse dialog.

const notifications: Array<string> = []
const approvals: Array<string> = []

const archive = new TextEncoder().encode("the superseded build").buffer
const stored: Array<ArrayBuffer> = []

describe("WclapMissing.resolve", () => {
    beforeAll(async () => {
        RuntimeNotifier.install({
            info: async () => {},
            approve: async request => {
                approvals.push(request.headline ?? "")
                return false
            },
            progress: () => ({message: "", terminate: () => {}}),
            notify: request => {notifications.push(request.message)}
        })
        const dropped = WclapStorage.idOf(await WclapStorage.urlFor(archive))
        const successor = "11111111-1111-4111-8111-111111111111"
        const index = JSON.stringify({
            version: 1, folders: [{
                name: "Community", wclaps: [{
                    uuid: successor, name: "Plugin", size: 1, url: "", credits: "", license: "MIT",
                    plugins: [{clapId: "com.example.plugin", name: "Plugin", vendor: "Example", features: []}],
                    supersedes: [dropped]
                }]
            }]
        })
        const routes: Record<string, string | ArrayBuffer> = {
            [OpenWclapAPI.IndexFile]: JSON.stringify({version: 1, folders: []}),
            [CommunityAPI.WclapsIndexFile]: index,
            [`${CommunityAPI.FileRoot}/wclaps/${dropped}.wclap`]: archive
        }
        vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
            const body = routes[input.split("?")[0]]
            return body === undefined ? new Response("missing", {status: 404}) : new Response(body, {status: 200})
        })
        vi.spyOn(WclapStorage, "exists").mockResolvedValue(false)
        vi.spyOn(WclapStorage, "store").mockImplementation(async bytes => {
            stored.push(bytes)
            return WclapStorage.urlFor(bytes)
        })
    })
    afterAll(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })
    it("restores a superseded build that left the index from its file", async () => {
        const url = await WclapStorage.urlFor(archive)
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} =
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        boxGraph.beginTransaction()
        const device = WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(primaryAudioUnitBox.audioEffects)
            box.url.setValue(url)
            box.clapId.setValue("com.example.plugin")
            box.label.setValue("Plugin")
        })
        boxGraph.endTransaction()
        await WclapMissing.resolve(boxGraph)
        expect(approvals).toStrictEqual([])
        expect(stored.map(bytes => new TextDecoder().decode(bytes))).toStrictEqual(["the superseded build"])
        expect(notifications).toStrictEqual(["WebCLAP plugin 'Plugin' (com.example.plugin) has been restored from the cloud"])
        expect(device.url.getValue()).toBe(url)
    })
})
