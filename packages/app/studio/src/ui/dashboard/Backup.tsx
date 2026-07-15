import {EmptyExec} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {CloudBackup} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {StudioService} from "@/service/StudioService"
import {NextcloudDialogs} from "@/project/NextcloudDialogs"
import {RailSection} from "@/ui/dashboard/RailSection"

type Construct = {
    service: StudioService
}

export const Backup = ({service}: Construct) => (
    <RailSection title="Backup & Sync">
        <button className="chip" title="Back up to Dropbox"
                onclick={() => CloudBackup.backup(service.cloudAuthManager, "Dropbox").catch(EmptyExec)}>
            <Icon symbol={IconSymbol.Dropbox}/><span>Dropbox</span>
        </button>
        <button className="chip" title="Back up to Google Drive"
                onclick={() => CloudBackup.backup(service.cloudAuthManager, "GoogleDrive").catch(EmptyExec)}>
            <Icon symbol={IconSymbol.GoogleDrive}/><span>Drive</span>
        </button>
        <button className="chip" title="Browse Nextcloud projects"
                onclick={() => NextcloudDialogs.browse(service)}>
            <Icon symbol={IconSymbol.Nextcloud}/><span>Nextcloud</span>
        </button>
    </RailSection>
)
