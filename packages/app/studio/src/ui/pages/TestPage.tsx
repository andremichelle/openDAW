import css from "./TestPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "TestPage")

export const TestPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <h1>Test Page</h1>
        </div>
    )
}