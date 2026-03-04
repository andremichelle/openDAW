import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {BackButton} from "@/ui/pages/BackButton"
import {S3Settings} from "@/ui/collab/S3Settings"
import {CollabSettings} from "@/ui/collab/CollabSettings"

export const CloudStoragePage: PageFactory<StudioService> = ({service}: PageContext<StudioService>) => {
    return (
        <div style={{padding: "24px", maxWidth: "600px", margin: "0 auto", flex: "1 0 0", overflow: "auto"}}>
            <BackButton/>
            <h1>Cloud Storage</h1>
            <S3Settings
                onSave={(config) => service.collabService.saveS3Config(config)}
                onClear={() => service.collabService.clearS3Config()}
            />
            <div style={{marginTop: "24px"}}/>
            <CollabSettings/>
        </div>
    )
}
