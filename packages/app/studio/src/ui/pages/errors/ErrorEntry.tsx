import css from "./ErrorEntry.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {Strings, TimeSpan} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Dialogs} from "@/ui/components/dialogs"
import {Stack} from "@/ui/pages/errors/Stack"
import {Logs} from "@/ui/pages/errors/Logs"
import {LogBuffer} from "@/errors/LogBuffer"

const className = Html.adoptStyleSheet(css, "ErrorEntry")

export type Entry = {
    id: string
    date: string
    user_agent: string
    build_uuid: string
    build_env: string
    build_date: string
    script_tags: string
    error_name: string
    error_message: string
    error_stack: string
    logs: string
    fixed: number
}

type Construct = {
    entry: Entry
}

export const ErrorEntry = ({entry}: Construct) => {
    const nowTime = new Date().getTime()
    const errorTime = new Date(entry.date).getTime()
    const errorTimeString = TimeSpan.millis(errorTime - nowTime).toUnitString()
    const buildTimeString = TimeSpan.millis(new Date(entry.build_date).getTime() - nowTime).toUnitString()
    const userAgent = entry.user_agent.replace(/^Mozilla\/[\d.]+\s*/, "")
    const errorMessage = Strings.fallback(entry.error_message, "No message")
    return (
        <div className={className && Html.buildClassList("row", entry.fixed === 1 && "fixed")}>
            <div>{entry.id}</div>
            <div>{errorTimeString}</div>
            <div>{buildTimeString}</div>
            <div>{entry.error_name}</div>
            <div className="error-message" title={errorMessage}>{errorMessage}</div>
            <div>{entry.script_tags}</div>
            <div className="browser" title={userAgent}>{userAgent}</div>
            <div style={{cursor: "pointer"}}
                 onclick={() => Dialogs.show({
                     headline: "Error Stack",
                     content: (<Stack stack={entry.error_stack}/>)
                 })}>
                📂
            </div>
            <div style={{cursor: "pointer"}}
                 onclick={() => {
                     const entries = JSON.parse(entry.logs) as Array<LogBuffer.Entry>
                     return Dialogs.show({
                         headline: "Logs",
                         content: (
                             <Logs errorTime={errorTime}
                                   entries={entries.reverse()}/>
                         )
                     })
                 }}>
                📂
            </div>
            <div>{entry.fixed ? "Yes 👍" : "No 🙄"}</div>
        </div>
    )
}