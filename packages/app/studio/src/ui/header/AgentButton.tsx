import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {Dialogs} from "@/ui/components/dialogs"
import {AgentConnection} from "@/script/AgentConnection"

type Construct = {
    lifecycle: Lifecycle
    connection: AgentConnection
}

export const AgentButton = ({lifecycle, connection}: Construct) => {
    const disconnect = async () => {
        const approved = await Dialogs.approve({
            headline: "Disconnect Agent",
            message: "The agent can no longer run scripts in this studio.",
            approveText: "Disconnect",
            cancelText: "Cancel"
        })
        if (approved) {connection.disconnect()}
    }
    const connected: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={() => disconnect().finally()}
                appearance={{color: Colors.green, activeColor: Colors.green, cursor: "pointer", tooltip: "Agent connected"}}>
            <Icon symbol={IconSymbol.Robot}/>
        </Button>
    )
    const waiting: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={() => disconnect().finally()}
                appearance={{color: Colors.orange, activeColor: Colors.orange, cursor: "pointer", tooltip: "Waiting for the agent relay"}}>
            <Icon symbol={IconSymbol.Robot}/>
        </Button>
    )
    const element: HTMLElement = <div style={{display: "flex"}}>{connected}{waiting}</div>
    lifecycle.own(connection.state.catchupAndSubscribe(owner => {
        const state = owner.getValue()
        element.classList.toggle("hidden", state === "off")
        connected.classList.toggle("hidden", state !== "connected")
        waiting.classList.toggle("hidden", state !== "waiting")
    }))
    return element
}
