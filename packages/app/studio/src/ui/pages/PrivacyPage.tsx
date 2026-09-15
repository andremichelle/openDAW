import css from "./PrivacyPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "PrivacyPage")

export const PrivacyPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <h1>Privacy Policy</h1>
        <p style={{color: Colors.blue.toString()}}>openDAW respects your privacy. This application does not collect
            personal data, or create user accounts.</p>
        <h3>Local storage</h3>
        <p>Your projects and samples are stored on your own device (local file system or browser storage). No
            personal information is sent to our servers.</p>
        <h3>Cloud connections</h3>
        <p>If you choose to connect a cloud service (e.g. Google Drive or Dropbox), openDAW uses the official OAuth
            process. The access tokens are stored only in your browser or desktop app and are never shared with us.</p>
        <h3>Data usage</h3>
        <p>openDAW does not process, analyze, or share any personal data. Files remain under your control in your chosen
            storage location.</p>
        <h3>Visitor counting</h3>
        <p>We count unique visitors per day. Our server derives a temporary identifier from data your browser sends
            with every request anyway (IP address and browser version), using a secret key that is deleted within
            24 hours, after which the identifier cannot be recreated. Nothing is stored on or read from your device,
            and no data is shared with anyone. This counting complies with the GDPR (DSGVO) and §25 TDDDG and
            therefore requires no consent banner.</p>
        <h3>Contact</h3>
        <p>For questions about this policy, contact: <a style={{color: Colors.blue}}
                                                        href="mailto:hello@opendaw.org">hello@opendaw.org</a>
        </p>
    </div>
)