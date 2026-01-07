import { Terminator } from "@opendaw/lib-std"
import { createElement, Frag, Router } from "@opendaw/lib-jsx"
import { WorkspacePage } from "@/ui/workspace/WorkspacePage.tsx"
import { StudioService } from "@/service/StudioService.ts"
import { ComponentsPage } from "@/ui/pages/ComponentsPage.tsx"
import { IconsPage } from "@/ui/pages/IconsPage.tsx"
import { AutomationPage } from "@/ui/pages/AutomationPage.tsx"
import { SampleUploadPage } from "@/ui/pages/SampleUploadPage.tsx"
import { Footer } from "@/ui/Footer"
import { OdieSidebar } from "@/ui/odie/OdieSidebar"

import { ManualPage } from "@/ui/pages/ManualPage"
import { ColorsPage } from "@/ui/pages/ColorsPage"
import { Header } from "@/ui/header/Header"
import { ErrorsPage } from "@/ui/pages/ErrorsPage.tsx"
import { ImprintPage } from "@/ui/pages/ImprintPage.tsx"
import { GraphPage } from "@/ui/pages/GraphPage"
import { CodeEditorPage } from "@/ui/pages/CodeEditorPage"
import { OpenBundlePage } from "@/ui/pages/OpenBundlePage"
import { UsersPage } from "@/ui/pages/UsersPage"
import { PrivacyPage } from "@/ui/pages/PrivacyPage"
import { TestPage } from "@/ui/pages/TestPage"

export const App = (service: StudioService) => {
    console.log("%c OpenDAW Next: Odie Integrated ", "background: purple; color: white; font-size: 20px")
    const terminator = new Terminator()
    return (
        <Frag>
            <Header lifecycle={new Terminator()} service={service} />
            <Router
                runtime={terminator}
                service={service}
                fallback={() => (
                    <div style={{ flex: "1 0 0", display: "flex", justifyContent: "center", alignItems: "center" }}>
                        <span style={{ fontSize: "50vmin" }}>404</span>
                    </div>
                )}
                routes={[
                    { path: "/", factory: WorkspacePage },

                    { path: "/manuals/*", factory: ManualPage },
                    { path: "/imprint", factory: ImprintPage },
                    { path: "/privacy", factory: PrivacyPage },
                    { path: "/icons", factory: IconsPage },
                    { path: "/code", factory: CodeEditorPage },
                    { path: "/scripting", factory: CodeEditorPage },
                    { path: "/components", factory: ComponentsPage },
                    { path: "/automation", factory: AutomationPage },
                    { path: "/errors", factory: ErrorsPage },
                    { path: "/upload", factory: SampleUploadPage },
                    { path: "/colors", factory: ColorsPage },
                    { path: "/graph", factory: GraphPage },
                    { path: "/users", factory: UsersPage },
                    { path: "/open-bundle/*", factory: OpenBundlePage },
                    { path: "/test", factory: TestPage }
                ]}
            />
            <OdieSidebar service={service} lifecycle={terminator} />
            <Footer lifecycle={terminator} service={service} />
        </Frag>
    )
}