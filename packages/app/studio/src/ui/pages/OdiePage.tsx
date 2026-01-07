import css from "./ManualPage.sass?inline" // Reuse ManualPage styles directly for consistency
import { createElement, LocalLink, PageContext, PageFactory } from "@opendaw/lib-jsx"
import { StudioService } from "@/service/StudioService.ts"
import { Html } from "@opendaw/lib-dom"
import { OdieSetupView } from "@/ui/odie/setup/OdieSetupView"
import { BackButton } from "./BackButton"

// Adopt ManualPage styles to ensure exact match
const className = Html.adoptStyleSheet(css, "ManualPage")

export const OdiePage: PageFactory<StudioService> = ({ service, path }: PageContext<StudioService>) => {

    // Determine the active tool based on the path
    const subRoute = path?.split("/")[2] || "setup" // Default to setup

    // Render Sub-Navigation
    const renderNav = () => (
        <nav>
            <LocalLink href="/odie/setup" className={subRoute === "setup" ? "active" : ""}>Setup Wizard</LocalLink>
            <LocalLink href="/odie/profile" className={subRoute === "profile" ? "active" : ""}>Profile</LocalLink>
            <LocalLink href="/odie/academy" className={subRoute === "academy" ? "active" : ""}>Academy</LocalLink>
            <LocalLink href="/odie/history" className={subRoute === "history" ? "active" : ""}>History</LocalLink>
            <hr />
            <LocalLink href="/odie/settings" className={subRoute === "settings" ? "active" : ""}>Settings</LocalLink>
        </nav>
    )

    // Render Main Content
    const renderContent = () => {
        if (subRoute === "setup") {
            return <OdieSetupView service={service.odieService} />
        }
        return (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
                <h2>Work In Progress</h2>
                <p>Migrating {subRoute}...</p>
            </div>
        )
    }

    return (
        <div className={className}>
            <aside>
                <BackButton />
                {renderNav()}
            </aside>
            <div className="manual">
                {renderContent()}
            </div>
        </div>
    )
}
