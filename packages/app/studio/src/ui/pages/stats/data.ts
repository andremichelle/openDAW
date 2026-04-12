import {isDefined} from "@opendaw/lib-std"

export type DailySeries = ReadonlyArray<readonly [date: string, value: number]>

export type RoomStats = {
    count: DailySeries
    duration: DailySeries
}

export type GitHubStats = {
    stars: number
    forks: number
    watchers: number
    openIssues: number
    latestRelease: string | undefined
}

export type DiscordStats = {
    name: string
    total: number
    online: number
}

export type ErrorStats = {
    total: number
    fixed: number
    unfixed: number
    ratio: string
}

export type Sponsor = {
    type: "User" | "Organization"
    login: string
    name: string | null
    avatarUrl: string
    url: string
}

export type SponsorStats = {
    fetchedAt: string | null
    totalCount: number
    sponsors: ReadonlyArray<Sponsor>
}

const sortByDate = (record: Record<string, number>): DailySeries =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))

const cacheGet = <T>(key: string, ttlMs: number): T | undefined => {
    const raw = sessionStorage.getItem(key)
    if (!isDefined(raw)) return undefined
    const parsed = JSON.parse(raw) as { at: number, value: T }
    if (Date.now() - parsed.at > ttlMs) return undefined
    return parsed.value
}

const cacheSet = <T>(key: string, value: T): void => {
    sessionStorage.setItem(key, JSON.stringify({at: Date.now(), value}))
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, init)
    if (!response.ok) {throw new Error(`${response.status} ${response.statusText}`)}
    return await response.json() as T
}

export const fetchRoomStats = async (): Promise<RoomStats> => {
    const [count, duration] = await Promise.all([
        fetchJson<Record<string, number>>("https://live.opendaw.studio/stats/rooms-count.json", {mode: "cors"}),
        fetchJson<Record<string, number>>("https://live.opendaw.studio/stats/rooms-duration.json", {mode: "cors"})
    ])
    return {count: sortByDate(count), duration: sortByDate(duration)}
}

export const fetchUserStats = async (): Promise<DailySeries> => {
    const data = await fetchJson<Record<string, number>>("https://api.opendaw.studio/users/graph.json", {
        mode: "cors",
        credentials: "include"
    })
    return sortByDate(data)
}

const GITHUB_REPO = "andremichelle/openDAW"
const GITHUB_CACHE_KEY = "stats:github"
const GITHUB_TTL = 10 * 60 * 1000

export const fetchGitHubStats = async (): Promise<GitHubStats> => {
    const cached = cacheGet<GitHubStats>(GITHUB_CACHE_KEY, GITHUB_TTL)
    if (isDefined(cached)) return cached
    type RepoResponse = {
        stargazers_count: number
        forks_count: number
        subscribers_count: number
        open_issues_count: number
    }
    type ReleaseResponse = { tag_name: string }
    const [repo, release] = await Promise.all([
        fetchJson<RepoResponse>(`https://api.github.com/repos/${GITHUB_REPO}`),
        fetchJson<ReleaseResponse>(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`).catch(() => undefined)
    ])
    const stats: GitHubStats = {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        watchers: repo.subscribers_count,
        openIssues: repo.open_issues_count,
        latestRelease: release?.tag_name
    }
    cacheSet(GITHUB_CACHE_KEY, stats)
    return stats
}

const DISCORD_INVITE = "ZRm8du7vn4"
const DISCORD_CACHE_KEY = "stats:discord"
const DISCORD_TTL = 5 * 60 * 1000

export const fetchDiscordStats = async (): Promise<DiscordStats> => {
    const cached = cacheGet<DiscordStats>(DISCORD_CACHE_KEY, DISCORD_TTL)
    if (isDefined(cached)) return cached
    type InviteResponse = {
        approximate_member_count: number
        approximate_presence_count: number
        guild: { name: string }
    }
    const data = await fetchJson<InviteResponse>(
        `https://discord.com/api/v10/invites/${DISCORD_INVITE}?with_counts=true`)
    const stats: DiscordStats = {
        name: data.guild.name,
        total: data.approximate_member_count,
        online: data.approximate_presence_count
    }
    cacheSet(DISCORD_CACHE_KEY, stats)
    return stats
}

export const fetchSponsorStats = async (): Promise<SponsorStats> =>
    fetchJson<SponsorStats>("/sponsors.json")

const ERROR_CACHE_KEY = "stats:errors"
const ERROR_TTL = 5 * 60 * 1000

export const fetchErrorStats = async (): Promise<ErrorStats> => {
    const cached = cacheGet<ErrorStats>(ERROR_CACHE_KEY, ERROR_TTL)
    if (isDefined(cached)) return cached
    type StatusResponse = { Total: number, Fixed: number, Unfixed: number, Ratio: string }
    const data = await fetchJson<StatusResponse>("https://logs.opendaw.studio/status.php")
    const stats: ErrorStats = {
        total: data.Total,
        fixed: data.Fixed,
        unfixed: data.Unfixed,
        ratio: data.Ratio
    }
    cacheSet(ERROR_CACHE_KEY, stats)
    return stats
}

export const sumValues = (series: DailySeries): number =>
    series.reduce((acc, [, value]) => acc + value, 0)

export const lastValue = (series: DailySeries): number =>
    series.length === 0 ? 0 : series[series.length - 1][1]

export const minutesToHours = (series: DailySeries): DailySeries =>
    series.map(([date, minutes]) => [date, minutes / 60] as const)

export const formatHours = (hours: number): string => {
    if (hours < 1) return `${Math.round(hours * 60)} min`
    if (hours < 100) return `${hours.toFixed(1)} h`
    return `${Math.round(hours)} h`
}

export const formatNumber = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
    return value.toString()
}
