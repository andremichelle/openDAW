import { createElement } from "@opendaw/lib-jsx"

export type StatusState = "active" | "error" | "thinking" | "idle"

export interface StatusIndicatorProps {
    status: StatusState
    tooltip: string
}

export const StatusIndicator = ({ status, tooltip }: StatusIndicatorProps) => {
    return <div
        className={`StatusIndicator ${status}`}
        title={tooltip} />
}
