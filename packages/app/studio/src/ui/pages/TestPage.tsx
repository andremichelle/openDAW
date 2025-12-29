import css from "./TestPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "TestPage")

export const TestPage: PageFactory<StudioService> = ({lifecycle: _lifecycle}: PageContext<StudioService>) => {
    return (
        <div className={className}>
            <h1>Test Page</h1>
        </div>
    )
}
