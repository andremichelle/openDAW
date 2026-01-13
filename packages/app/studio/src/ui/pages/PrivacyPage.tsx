import css from "./PrivacyPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "PrivacyPage")

export const PrivacyPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => (
    <div className={className}>
        <h1>Privacy Policy</h1>
        <p style={{color: Colors.blue.toString()}}>openDAW respects your privacy. This application does not collect
            personal data, create user accounts, or track visitors.</p>
        <h3>Local storage</h3>
        <p>Your projects and samples are stored on your own device (local file system or browser storage). No
            personal information is sent to our servers.</p>
        <h3>Cloud connections</h3>
        <p>If you choose to connect a cloud service (e.g. Google Drive or Dropbox), openDAW uses the official OAuth
            process. The access tokens are stored only in your browser or desktop app and are never shared with us.</p>
        <h3>Data usage</h3>
        <p>openDAW does not process, analyze, or share any personal data. Files remain under your control in your chosen
            storage location.</p>
        <h3>Contact</h3>
        <p>For questions about this policy, contact: <a style={{color: Colors.blue}}
                                                        href="mailto:hello@moises-ai.org">hello@moises-ai.org</a>
        </p>
    </div>
)