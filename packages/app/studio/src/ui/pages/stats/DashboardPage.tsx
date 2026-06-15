import css from "./DashboardPage.sass?inline"
import {Await, createElement, Frag, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {DefaultObservableValue, int, Lifecycle} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import type {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {BarChart, LineChart} from "./charts"
import {Card} from "./components"
import {Tile} from "./Tile"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {
    BuildInfo,
    DailySeries,
    DiscordStats,
    dropPartialDay,
    ErrorStats,
    fetchBuildInfo,
    fetchDiscordStats,
    fetchErrorStats,
    fetchGitHubStats,
    fetchLatencyStats,
    fetchNpmWeeklyDownloads,
    fetchRoomStats,
    fetchSponsorStats,
    fetchUserStats,
    fetchVisitorStats,
    formatHours,
    formatNumber,
    formatRelativeDate,
    GitHubStats,
    LatencyStats,
    minutesToHours,
    RoomStats,
    SponsorStats,
    sumValues
} from "./data"

const className = Html.adoptStyleSheet(css, "DashboardPage")

const NPM_PACKAGE = "@opendaw/lib-std"

type DashboardData = {
    rooms: RoomStats
    users: DailySeries
    visitors: DailySeries
}

type LiveTiles = {
    peakUsers: HTMLSpanElement
    maxVisitors: HTMLSpanElement
}

const unionDates = (data: DashboardData): ReadonlyArray<string> => {
    const set = new Set<string>()
    data.rooms.count.forEach(([date]) => set.add(date))
    data.rooms.duration.forEach(([date]) => set.add(date))
    data.users.forEach(([date]) => set.add(date))
    data.visitors.forEach(([date]) => set.add(date))
    return [...set].sort()
}

type StatsBodyProps = {
    lifecycle: Lifecycle
    data: DashboardData
    tiles: LiveTiles
}

const StatsBody = ({lifecycle, data: rawData, tiles}: StatsBodyProps) => {
    const data: DashboardData = {
        rooms: {count: dropPartialDay(rawData.rooms.count), duration: dropPartialDay(rawData.rooms.duration)},
        users: dropPartialDay(rawData.users),
        visitors: dropPartialDay(rawData.visitors)
    }
    const dates = unionDates(data)
    if (dates.length === 0) {
        return <div className="loading">No statistics available yet.</div>
    }
    const liveRoomsSeries = lifecycle.own(new DefaultObservableValue<DailySeries>(data.rooms.count))
    const liveHoursSeries = lifecycle.own(new DefaultObservableValue<DailySeries>(minutesToHours(data.rooms.duration)))
    const peakUsersSeries = lifecycle.own(new DefaultObservableValue<DailySeries>(data.users))
    const visitorsSeries = lifecycle.own(new DefaultObservableValue<DailySeries>(data.visitors))
    tiles.peakUsers.textContent = formatNumber(Math.max(0, ...data.users.map(([, value]) => value)))
    tiles.maxVisitors.textContent = formatNumber(Math.max(0, ...data.visitors.map(([, value]) => value)))
    const latencySeries = lifecycle.own(new DefaultObservableValue<DailySeries>([]))
    return (
        <Frag>
            <div className="grid">
                <div className="span-12">
                    <Card title="Daily Unique Visitors" accent={<span>unique visitors per day</span>} className="hero">
                        <LineChart lifecycle={lifecycle} series={visitorsSeries} color={Colors.orange.toString()}/>
                    </Card>
                </div>
                <div className="span-12">
                    <Card title="Daily Peak Users" accent={<span>peak concurrent users</span>} className="hero">
                        <LineChart lifecycle={lifecycle} series={peakUsersSeries} color={Colors.green.toString()}/>
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
            <Await
                factory={() => fetchLatencyStats()}
                loading={() => null}
                failure={() => null}
                success={({distribution, unsupported, total}: LatencyStats) => {
                    latencySeries.setValue(distribution)
                    const parts = [`${formatNumber(total)} measurements`]
                    if (unsupported > 0) {parts.push(`${formatNumber(unsupported)} unsupported`)}
                    const subtitle = parts.join(" · ")
                    return (
                        <Card title="Audio Output Latency" accent={<span>{subtitle}</span>} className="compact">
                            <BarChart lifecycle={lifecycle} series={latencySeries} color={Colors.cream.toString()}
                                      peakLabels={true} unit="%"/>
                        </Card>
                    )
                }}
            />
        </Frag>
    )
}

const GitHubTiles = ({stats}: { stats: GitHubStats }) => (
    <Frag>
        <Tile label="GitHub stars" value={formatNumber(stats.stars)}/>
        <Tile label="GitHub forks" value={formatNumber(stats.forks)}/>
        <Tile label="GitHub watchers" value={formatNumber(stats.watchers)}/>
        <Tile label="GitHub Open issues" value={formatNumber(stats.openIssues)}/>
        <Tile label="GitHub Last commit" value={formatRelativeDate(stats.lastCommit)}/>
    </Frag>
)

const DiscordTiles = ({stats}: { stats: DiscordStats }) => (
    <Frag>
        <Tile label="Discord members" value={formatNumber(stats.total)}/>
        <Tile label="Discord online" value={formatNumber(stats.online)}/>
    </Frag>
)

const AllTimeTiles = ({data}: { data: DashboardData }) => {
    const totalRooms = sumValues(data.rooms.count)
    const totalMinutes = sumValues(data.rooms.duration)
    const totalHours = totalMinutes / 60
    return (
        <Frag>
            <Tile label="Rooms Total Create" value={formatNumber(totalRooms)}/>
            <Tile label="Rooms Total Hours" value={formatHours(totalHours)}/>
        </Frag>
    )
}

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
        peakUsers: <span/>,
        maxVisitors: <span/>
    }
    const dataPromise: Promise<DashboardData> = (async () => {
        const [rooms, users, visitors] = await Promise.all([
            fetchRoomStats(),
            fetchUserStats().catch(() => [] as DailySeries),
            fetchVisitorStats().catch(() => [] as DailySeries)
        ])
        return {rooms, users, visitors}
    })()
    return (
        <div className={className} onConnect={host => lifecycle.own(installScrollbars(host))}>
            <header className="dashboard-head">
                <h1>openDAW Statistics</h1>
                <span className="updated">Updated {updatedAt}</span>
            </header>
            <Await
                factory={() => fetchSponsorStats()}
                loading={() => null}
                failure={() => null}
                success={(stats: SponsorStats) => stats.totalCount > 0 ? <SponsorsCard stats={stats}/> : null}
            />
            <div className="tiles">
                <Await
                    factory={() => fetchGitHubStats()}
                    loading={() => <Tile label="GitHub" value="…"/>}
                    failure={() => <Tile label="GitHub" value="n/a"/>}
                    success={(stats: GitHubStats) => <GitHubTiles stats={stats}/>}
                />
                <Await
                    factory={() => fetchDiscordStats()}
                    loading={() => <Tile label="Discord" value="…"/>}
                    failure={() => <Tile label="Discord" value="n/a"/>}
                    success={(stats: DiscordStats) => <DiscordTiles stats={stats}/>}
                />
                <Await
                    factory={() => fetchErrorStats()}
                    loading={() => <Tile label="Errors" value="…"/>}
                    failure={() => <Tile label="Errors" value="n/a"/>}
                    success={(stats: ErrorStats) => (
                        <Tile label="Errors fixed" value={stats.ratio}/>
                    )}
                />
                <Await
                    factory={() => fetchNpmWeeklyDownloads(NPM_PACKAGE)}
                    loading={() => <Tile label="SDK Downloads/Week" value="…"/>}
                    failure={() => <Tile label="SDK Downloads/Week" value="n/a"/>}
                    success={(downloads: int) => (
                        <Tile label="SDK Downloads/Week" value={formatNumber(downloads)}/>
                    )}
                />
                <Await
                    factory={() => fetchBuildInfo()}
                    loading={() => <Tile label="Last build" value="…"/>}
                    failure={() => <Tile label="Last build" value="n/a"/>}
                    success={(info: BuildInfo) => (
                        <Tile label="Last build" value={formatRelativeDate(info.date)}/>
                    )}
                />
                <Await
                    factory={() => dataPromise}
                    loading={() => <Tile label="All-time" value="…"/>}
                    failure={() => <Tile label="All-time" value="n/a"/>}
                    success={(data: DashboardData) => <AllTimeTiles data={data}/>}
                />
                <Tile label="Peak users" value={tiles.peakUsers}/>
                <Tile label="Max unique visitors" value={tiles.maxVisitors}/>
            </div>
            <Await
                factory={() => dataPromise}
                loading={() => <ThreeDots/>}
                failure={({reason}) => <p className="error">Failed to load stats: {reason}</p>}
                success={(data: DashboardData) => <StatsBody lifecycle={lifecycle} data={data} tiles={tiles}/>}
            />
        </div>
    )
}
