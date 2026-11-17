import css from "./AgentTaskDialog.sass?inline"
import {Exec, Terminable} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {AgentTask} from "@/script/AgentTask"

const className = Html.adoptStyleSheet(css, "AgentTaskDialog")

export namespace AgentTaskDialog {
    const formatElapsed = (millis: number): string => {
        const seconds = Math.floor(millis / 1000)
        return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    }

    export const show = (task: AgentTask, onCancel: Exec): Terminable => {
        const elapsed: HTMLElement = <span className="value">00:00</span>
        const calls: HTMLElement = <span className="value">0</span>
        const title: HTMLElement = <p/>
        const dialog: HTMLDialogElement = (
            <Dialog headline="Agent at Work"
                    icon={IconSymbol.Robot}
                    cancelable={false}
                    buttons={[{
                        text: "Cancel",
                        onClick: handler => {
                            handler.close()
                            onCancel()
                        }
                    }]}>
                <div className={className}>
                    {title}
                    <div className="stats">
                        <span>Time</span>{elapsed}
                        <span>Calls</span>{calls}
                    </div>
                </div>
            </Dialog>
        )
        const interval = window.setInterval(() =>
            elapsed.textContent = formatElapsed(performance.now() - task.startTime), 1000)
        const subscriptions = [
            task.calls.catchupAndSubscribe(owner => calls.textContent = String(owner.getValue())),
            task.title.catchupAndSubscribe(owner => title.textContent = owner.getValue())
        ]
        dialog.addEventListener("close", () => {
            clearInterval(interval)
            subscriptions.forEach(subscription => subscription.terminate())
        })
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        return {terminate: () => {if (dialog.open) {dialog.close()}}}
    }
}
