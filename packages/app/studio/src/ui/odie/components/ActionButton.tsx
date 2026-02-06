import { createElement } from "@opendaw/lib-jsx"

export interface ActionButtonProps {
    icon: string
    label: string
    onClick: (e: MouseEvent) => void
    pulse?: boolean
    id?: string
}

export const ActionButton = ({ icon, label, onClick, pulse = false, id, children }: ActionButtonProps & { children?: any }) => {
    return <button
        className={`ActionButton ${pulse ? 'pulse' : ''}`}
        id={id}
        onClick={onClick}
        title={label}>
        {children || <i className={`icon-${icon}`} />}
    </button>
}
