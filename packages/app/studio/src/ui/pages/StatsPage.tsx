import css from "./StatsPage.sass?inline"
import {createElement, LocalLink, PageFactory} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import type {StudioService} from "@/service/StudioService.ts"

const className = Html.adoptStyleSheet(css, "StatsPage")

export const StatsPage: PageFactory<StudioService> = () => {
    return (
        <div className={className}>
            <h1>Stats</h1>
            <ul>
                <li><LocalLink href="/stats/users">Peak Concurrent Users</LocalLink></li>
                <li><LocalLink href="/stats/rooms-created">Rooms Created Per Day</LocalLink></li>
                <li><LocalLink href="/stats/rooms-duration">Total Room Duration Per Day</LocalLink></li>
            </ul>
        </div>
    )
}
