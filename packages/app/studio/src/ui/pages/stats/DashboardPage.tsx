import css from "./DashboardPage.sass?inline"
import {Await, createElement, Frag, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import type {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {BarChart, LineChart} from "./charts"
import {Card, RangeControl} from "./components"
import {Tile} from "./Tile"
import {
    DailySeries,
    DiscordStats,
    ErrorStats,
    GitHubStats,
    RoomStats,
    SponsorStats,
    fetchDiscordStats,
    fetchErrorStats,
    fetchGitHubStats,
    fetchRoomStats,
    fetchSponsorStats,
    fetchUserStats,
    formatNumber,
    minutesToHours
} from "./data"

const className = Html.adoptStyleSheet(css, "DashboardPage")

type DashboardData = {
    rooms: RoomStats
    users: DailySeries
}

type LiveTiles = {
    peakUsers: HTMLDivElement
}

const sliceSeries = (series: DailySeries, fromDate: string, toDate: string): DailySeries =>
    series.filter(([date]) => date >= fromDate && date <= toDate)

const unionDates = (data: DashboardData): ReadonlyArray<string> => {
    const set = new Set<string>()
    data.rooms.count.forEach(([date]) => set.add(date))
    data.rooms.duration.forEach(([date]) => set.add(date))
    data.users.forEach(([date]) => set.add(date))
    return [...set].sort()
}

type StatsBodyProps = {
    lifecycle: Lifecycle
    data: DashboardData
    tiles: LiveTiles
}

const StatsBody = ({lifecycle, data, tiles}: StatsBodyProps) => {
    const dates = unionDates(data)
    if (dates.length === 0) {
        return <div className="loading">No statistics available yet.</div>
    }
    const range = lifecycle.own(new DefaultObservableValue<readonly [number, number]>([0, dates.length - 1]))
    const liveRoomsSeries = lifecycle.own(new DefaultObservableValue<DailySeries>([]))
    const liveHoursSeries = lifecycle.own(new DefaultObservableValue<DailySeries>([]))
    const peakUsersSeries = lifecycle.own(new DefaultObservableValue<DailySeries>([]))
    lifecycle.own(range.catchupAndSubscribe(owner => {
        const [fromIndex, toIndex] = owner.getValue()
        const fromDate = dates[fromIndex]
        const toDate = dates[toIndex]
        const liveRooms = sliceSeries(data.rooms.count, fromDate, toDate)
        const liveHours = minutesToHours(sliceSeries(data.rooms.duration, fromDate, toDate))
        const peakUsers = sliceSeries(data.users, fromDate, toDate)
        liveRoomsSeries.setValue(liveRooms)
        liveHoursSeries.setValue(liveHours)
        peakUsersSeries.setValue(peakUsers)
        tiles.peakUsers.textContent = formatNumber(Math.max(0, ...peakUsers.map(([, value]) => value)))
    }))
    return (
        <Frag>
            <div className="grid">
                <div className="span-12">
                    <Card title="Daily Peak Users" accent={<span>concurrent</span>} className="hero">
                        <LineChart lifecycle={lifecycle} series={peakUsersSeries} color={Colors.green.toString()}/>
                        <RangeControl lifecycle={lifecycle} dates={dates} range={range}/>
                    </Card>
                </div>
                <div className="span-6">
                    <Card title="Daily Live Rooms" accent={<span>rooms per day</span>} className="compact">
                        <LineChart lifecycle={lifecycle} series={liveRoomsSeries} color={Colors.purple.toString()}/>
                    </Card>
                </div>
                <div className="span-6">
                    <Card title="Daily Live Rooms Hours" accent={<span>hours per day</span>} className="compact">
                        <BarChart lifecycle={lifecycle} series={liveHoursSeries} color={Colors.blue.toString()}/>
                    </Card>
                </div>
            </div>
        </Frag>
    )
}

const GitHubTiles = ({stats}: { stats: GitHubStats }) => (
    <Frag>
        <Tile label="GitHub stars" value={formatNumber(stats.stars)} icon="★"/>
        <Tile label="GitHub forks" value={formatNumber(stats.forks)} icon="⑂"/>
    </Frag>
)

const DiscordTiles = ({stats}: { stats: DiscordStats }) => (
    <Frag>
        <Tile label="Discord members" value={formatNumber(stats.total)} icon="D"/>
        <Tile label="Discord online" value={formatNumber(stats.online)} icon="●"/>
    </Frag>
)

const ErrorTiles = ({stats}: { stats: ErrorStats }) => (
    <Tile label="Errors fixed" value={stats.ratio} icon="✓"/>
)

const SponsorsCard = ({stats}: { stats: SponsorStats }) => {
    const grid: HTMLDivElement = <div className="sponsors"/>
    grid.append(...stats.sponsors.map(sponsor => (
        <a className="sponsor" href={sponsor.url} target="_blank" rel="noopener noreferrer"
           title={sponsor.name ?? sponsor.login}>
            <img className="sponsor-avatar" src={sponsor.avatarUrl} alt={sponsor.login} loading="lazy"/>
            <span className="sponsor-name">{sponsor.name ?? sponsor.login}</span>
        </a>
    )))
    return (
        <Card title="GitHub Sponsors" accent={<span>{formatNumber(stats.totalCount)} supporters · thank you ♥</span>}>
            {grid}
        </Card>
    )
}

export const DashboardPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    const updatedAt = new Date().toLocaleString()
    const tiles: LiveTiles = {
        peakUsers: <div className="tile-value"/>
    }
    return (
        <div className={className}>
            <header className="dashboard-head">
                <h1>openDAW Statistics</h1>
                <span className="updated">Updated {updatedAt}</span>
            </header>
            <div className="tiles">
                <Await
                    factory={() => fetchGitHubStats()}
                    loading={() => <Tile label="GitHub" value="…" icon="★"/>}
                    failure={() => <Tile label="GitHub" value="n/a" icon="★"/>}
                    success={(stats: GitHubStats) => <GitHubTiles stats={stats}/>}
                />
                <Await
                    factory={() => fetchDiscordStats()}
                    loading={() => <Tile label="Discord" value="…" icon="D"/>}
                    failure={() => <Tile label="Discord" value="n/a" icon="D"/>}
                    success={(stats: DiscordStats) => <DiscordTiles stats={stats}/>}
                />
                <Await
                    factory={() => fetchErrorStats()}
                    loading={() => <Tile label="Errors" value="…" icon="!"/>}
                    failure={() => <Tile label="Errors" value="n/a" icon="!"/>}
                    success={(stats: ErrorStats) => <ErrorTiles stats={stats}/>}
                />
                <Tile label="Peak users (range)" value={tiles.peakUsers} icon="U"/>
            </div>
            <Await
                factory={() => fetchSponsorStats()}
                loading={() => null}
                failure={() => null}
                success={(stats: SponsorStats) => stats.totalCount > 0 ? <SponsorsCard stats={stats}/> : null}
            />
            <Await
                factory={async (): Promise<DashboardData> => {
                    const [rooms, users] = await Promise.all([
                        fetchRoomStats(),
                        fetchUserStats().catch(() => [] as DailySeries)
                    ])
                    return {rooms, users}
                }}
                loading={() => <ThreeDots/>}
                failure={({reason}) => <p className="error">Failed to load stats: {reason}</p>}
                success={(data: DashboardData) => <StatsBody lifecycle={lifecycle} data={data} tiles={tiles}/>}
            />
        </div>
    )
}
