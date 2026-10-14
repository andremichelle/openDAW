import {UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageScan} from "@opendaw/studio-adapters"
import {
    PresetStorage,
    ProjectMeta,
    ProjectStorage,
    SampleStorage,
    ScriptStorage,
    SoundfontStorage,
    WclapStorage,
    Workers
} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

// every kind goes through its own storage, so trash lists and tombstones carry the deletion into the cloud backup
export namespace StorageDeletion {
    export const deleteAsset = async ({kind, id}: StorageScan.AssetRef): Promise<void> => {
        switch (kind) {
            case "sample":
                return SampleStorage.get().deleteItem(UUID.parse(id))
            case "soundfont":
                return SoundfontStorage.get().deleteItem(UUID.parse(id))
            case "wclap":
                return WclapStorage.remove(id)
        }
    }

    export const deleteItem = async (service: StudioService, {kind, id, path}: StorageScan.Item): Promise<void> => {
        switch (kind) {
            case "project": {
                const uuid = UUID.parse(id)
                const meta = await Promises.tryCatch(ProjectStorage.loadMeta(uuid))
                return meta.status === "resolved"
                    ? service.deleteProject(uuid, ProjectMeta.fromJSON(JSON.parse(new TextDecoder().decode(meta.value))))
                    : ProjectStorage.deleteProject(uuid)
            }
            case "template":
                return service.deleteTemplate(UUID.parse(id))
            case "preset":
                return PresetStorage.remove(UUID.parse(id))
            case "script":
                return ScriptStorage.get().delete(UUID.parse(id))
            case "model":
            case "nam-pack":
                return Workers.Opfs.delete(path)
        }
    }
}
