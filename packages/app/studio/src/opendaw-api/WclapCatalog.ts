import {Lazy, Option, Progress} from "@opendaw/lib-std"
import {CommunityAPI} from "./CommunityAPI"
import {OpenWclapAPI} from "./OpenWclapAPI"
import {WclapIndex, WclapIndexEntry, WclapIndexFolder} from "./WclapIndex"

const hasContent = (folder: WclapIndexFolder): boolean =>
    (folder.wclaps?.length ?? 0) > 0 || (folder.folders ?? []).some(hasContent)

// the cloud WebCLAPs and the community ones as one catalogue, a bundle loads from where it is published
export class WclapCatalog {
    @Lazy
    static get(): WclapCatalog {return new WclapCatalog()}

    private constructor() {}

    async trees(): Promise<{ cloud: WclapIndex, community: WclapIndex }> {
        const [cloud, community] = await Promise.all([OpenWclapAPI.get().tree(), CommunityAPI.get().wclaps()])
        return {cloud, community: {...community, folders: community.folders.filter(hasContent)}}
    }

    async tree(): Promise<WclapIndex> {
        const {cloud, community} = await this.trees()
        return {version: 1, folders: [...cloud.folders, ...community.folders]}
    }

    async all(): Promise<ReadonlyArray<WclapIndexEntry>> {return WclapIndex.flatten(await this.tree())}

    async find(uuid: string): Promise<Option<WclapIndexEntry>> {
        return Option.wrap((await this.all()).find(entry => entry.uuid === uuid))
    }

    async successorOf(uuid: string): Promise<Option<WclapIndexEntry>> {
        return Option.wrap((await this.all()).find(entry => entry.supersedes.includes(uuid)))
    }

    async load(uuid: string, progress: Progress.Handler = Progress.Empty): Promise<ArrayBuffer> {
        const community = WclapIndex.flatten(await CommunityAPI.get().wclaps()).some(entry => entry.uuid === uuid)
        return community ? CommunityAPI.get().loadWclap(uuid, progress) : OpenWclapAPI.get().load(uuid, progress)
    }
}
