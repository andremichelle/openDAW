import {isDefined, Terminator} from "@opendaw/lib-std"
import {createElement, Frag, Router} from "@opendaw/lib-jsx"
import {WorkspacePage} from "@/ui/workspace/WorkspacePage.tsx"
import {StudioService} from "@/service/StudioService.ts"
import {ComponentsPage} from "@/ui/pages/ComponentsPage.tsx"
import {IconsPage} from "@/ui/pages/IconsPage.tsx"
import {AutomationPage} from "@/ui/pages/AutomationPage.tsx"
import {SampleUploadPage} from "@/ui/pages/SampleUploadPage.tsx"
import {Footer} from "@/ui/Footer"
import {RoomStatus} from "@/ui/RoomStatus"
import {ChatOverlay} from "@/ui/ChatOverlay"
import {ManualPage} from "@/ui/pages/ManualPage"
import {ColorsPage} from "@/ui/pages/ColorsPage"
import {Header} from "@/ui/header/Header"
import {ErrorsPage} from "@/ui/pages/ErrorsPage.tsx"
import {ImprintPage} from "@/ui/pages/ImprintPage.tsx"
import {GraphPage} from "@/ui/pages/GraphPage"
import {CodeEditorPage} from "@/ui/pages/CodeEditorPage"
import {OpenBundlePage} from "@/ui/pages/OpenBundlePage"
import {DashboardPage} from "@/ui/pages/stats/DashboardPage"
import {PrivacyPage} from "@/ui/pages/PrivacyPage"
import {PreferencesPage} from "@/ui/pages/PreferencesPage"
import {TestPage} from "@/ui/pages/TestPage"
import {JoinRoomPage} from "@/ui/pages/JoinRoomPage"
import {PerformancePage} from "@/ui/pages/PerformancePage"

export const App = (service: StudioService) => {
    const terminator = new Terminator()
    const favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (isDefined(favicon)) {
        terminator.own(service.roomAwareness.catchupAndSubscribe(owner =>
            favicon.href = isDefined(owner.getValue()) ? "/favicon-live.svg" : "/favicon.svg"))
    }
    return (
        <Frag>
            <Header lifecycle={new Terminator()} service={service}/>
            <Router
                runtime={terminator}
                service={service}
                fallback={() => (
                    <div style={{flex: "1 0 0", display: "flex", justifyContent: "center", alignItems: "center"}}>
                        <span style={{fontSize: "50vmin"}}>404</span>
                    </div>
                )}
                routes={[
                    {path: "/", factory: WorkspacePage},
                    {path: "/manuals/*", factory: ManualPage},
                    {path: "/preferences", factory: PreferencesPage},
                    {path: "/imprint", factory: ImprintPage},
                    {path: "/privacy", factory: PrivacyPage},
                    {path: "/icons", factory: IconsPage},
                    {path: "/code", factory: CodeEditorPage},
                    {path: "/scripting", factory: CodeEditorPage},
                    {path: "/components", factory: ComponentsPage},
                    {path: "/automation", factory: AutomationPage},
                    {path: "/errors", factory: ErrorsPage},
                    {path: "/upload", factory: SampleUploadPage},
                    {path: "/colors", factory: ColorsPage},
                    {path: "/graph", factory: GraphPage},
                    {path: "/stats", factory: DashboardPage},
                    {
                        path: "/users", factory: (context) => {
                            history.replaceState(null, "", "/stats")
                            return DashboardPage(context)
                        }
                    },
                    {path: "/open-bundle/*", factory: OpenBundlePage},
                    {path: "/test", factory: TestPage},
                    {path: "/performance", factory: PerformancePage},
                    {path: "/join/*", factory: JoinRoomPage}
                ]}
            />
            <ChatOverlay lifecycle={terminator} service={service}/>
            <RoomStatus lifecycle={terminator} service={service}/>
            <Footer lifecycle={terminator} service={service}/>
        </Frag>
    )
}