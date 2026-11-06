import css from "./PrivacyPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {BackButton} from "@/ui/pages/BackButton"

const className = Html.adoptStyleSheet(css, "PrivacyPage")

export const PrivacyPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => (
    <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
        <BackButton lifecycle={lifecycle} service={service}/>
        <h1>Privacy Policy</h1>
        <p style={{color: Colors.blue.toString()}}>openDAW respects your privacy. This application does not collect
            personal data, or create user accounts.</p>
        <h3>Local storage</h3>
        <p>Your projects and samples are stored on your own device (local file system or browser storage). No
            personal information is sent to our servers.</p>
        <h3>Cloud connections</h3>
        <p>If you choose to connect a cloud service (e.g. Google Drive or Dropbox), openDAW uses the official OAuth
            process. The access tokens are stored only in your browser or desktop app and are never shared with us.</p>
        <p>If you upload a mixdown to SoundCloud, you log in on SoundCloud's own page and openDAW never sees your
            password. SoundCloud requires an app secret to issue the access token, so this one step runs through our
            server, which passes the token on to your browser without storing it. The rendered audio, the project name,
            tags, description and cover are sent directly from your browser to SoundCloud.</p>
        <h3>Live rooms</h3>
        <p>When you join a live room, the project, the name and color you choose, chat messages and your pointer
            position are shared through our server with everyone in the room. Nothing is kept: the room and its data
            are deleted about a minute after the last person leaves. Samples and other files are sent directly between
            the participants' browsers.</p>
        <p>If you join a call, your microphone, camera or shared screen go directly and encrypted to the other
            participants. When a direct connection is not possible, the encrypted stream passes through our relay
            server, which cannot read it. Nothing is recorded or stored. To connect, the browsers of the participants
            exchange their IP addresses through our server. Everyone in a room sees and hears what you share there, so
            only share a room link with people you trust.</p>
        <p>When someone follows your playback, whether you play and your position in the project are sent to them
            through our server. Nothing is sent while nobody follows you.</p>
        <h3>Data usage</h3>
        <p>openDAW does not process, analyze, or share any personal data. Files remain under your control in your chosen
            storage location.</p>
        <h3>Visitor counting</h3>
        <p>We count unique visitors per day. Our server derives a temporary identifier from data your browser sends
            with every request anyway (IP address and browser version), using a secret key that is deleted within
            24 hours, after which the identifier cannot be recreated. Nothing is stored on or read from your device,
            and no data is shared with anyone. This counting complies with the GDPR (DSGVO) and §25 TDDDG and
            therefore requires no consent banner.</p>
        <h3>Error reports</h3>
        <p>When openDAW or its audio engine runs into an error, a report is sent to our server so we can fix it. It
            contains the error, the openDAW version, your browser signature (browser name, version and operating
            system) and a technical log of the last steps before the error. Before it is sent, every name is blanked
            in it, such as the names of your projects, tracks, samples, soundfonts and presets, the room name and the
            names of everyone in a live room. A report contains no personal data, no audio and no project content, and
            it is used for nothing else.</p>
        <h3>Contact</h3>
        <p>For questions about this policy, contact: <a style={{color: Colors.blue}}
                                                        href="mailto:hello@opendaw.org">hello@opendaw.org</a>
        </p>
    </div>
)