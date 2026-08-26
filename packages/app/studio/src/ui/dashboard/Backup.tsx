import {EmptyExec} from "@opendaw/lib-std"
import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {CloudBackup} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {StudioService} from "@/service/StudioService"
import {NextcloudDialogs} from "@/project/NextcloudDialogs"
import {RailSection} from "@/ui/dashboard/RailSection"

type Construct = {
    service: StudioService
}

// The action itself is the entry; the trailing '?' opens the manual for that service.
const HelpLink = ({path, title}: { path: string, title: string }) => (
    <button className="help" title={title} onclick={() => RouteLocation.get().navigateTo(path)}>
        <Icon symbol={IconSymbol.Help}/>
    </button>
)

export const Backup = ({service}: Construct) => (
    <RailSection title="Backup & Sync" vertical={true}>
        <div className="entry">
            <button className="link" title="Back up to Dropbox"
                    onclick={() => CloudBackup.backup(service.cloudAuthManager, "Dropbox").catch(EmptyExec)}>
                <Icon symbol={IconSymbol.Dropbox}/><span>Dropbox</span>
            </button>
            <HelpLink path="/manuals/cloud-backup" title="Read about Dropbox backup"/>
        </div>
        <div className="entry">
            <button className="link" title="Back up to Google Drive"
                    onclick={() => CloudBackup.backup(service.cloudAuthManager, "GoogleDrive").catch(EmptyExec)}>
                <Icon symbol={IconSymbol.GoogleDrive}/><span>Drive</span>
            </button>
            <HelpLink path="/manuals/cloud-backup" title="Read about Google Drive backup"/>
        </div>
        <div className="entry">
            <button className="link" title="Browse Nextcloud projects"
                    onclick={() => NextcloudDialogs.browse(service)}>
                <Icon symbol={IconSymbol.Nextcloud}/><span>Nextcloud</span>
            </button>
            <HelpLink path="/manuals/nextcloud" title="Read about Nextcloud sync"/>
        </div>
    </RailSection>
)
