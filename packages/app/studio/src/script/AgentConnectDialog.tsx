import css from "./AgentConnectDialog.sass?inline"
import {DefaultObservableValue, isDefined, Terminator} from "@opendaw/lib-std"
import {Browser, Clipboard, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Button} from "@/ui/components/Button"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Surface} from "@/ui/surface/Surface"
import {AgentConnection, AgentRelayMode} from "@/script/AgentConnection"

const className = Html.adoptStyleSheet(css, "AgentConnectDialog")

export namespace AgentConnectDialog {
    const TokenTimeoutMillis = 5000
    const Quiet = Browser.isWindows() ? ">$null 2>&1" : ">/dev/null 2>&1"
    const LocalCommand =
        `claude mcp remove -s user opendaw-local ${Quiet}; claude mcp add -s user opendaw-local -- npx -y @opendaw/mcp-relay`

    const serverCommand = (token: string): string =>
        `claude mcp remove -s user opendaw ${Quiet}; claude mcp add -s user --transport http opendaw ${AgentConnection.ServerMcpUrl} --header "Authorization: Bearer ${token}"`

    export const show = (connection: AgentConnection): void => {
        const lifecycle = new Terminator()
        const mode = new DefaultObservableValue<AgentRelayMode>(connection.mode.getValue())
        const noRenew = new DefaultObservableValue<boolean>(true)
        const copy = async (text: string, origin: Element) => {
            const {status} = await Promises.tryCatch(Clipboard.writeText(text))
            if (status === "resolved") {Surface.get(origin).toast("Command copied to clipboard", IconSymbol.Copy)}
        }
        const awaitToken = (): Promise<boolean> => new Promise(resolve => {
            const timer = window.setTimeout(() => {
                subscription.terminate()
                resolve(false)
            }, TokenTimeoutMillis)
            const subscription = connection.token.subscribe(option => {
                if (option.isEmpty()) {return}
                clearTimeout(timer)
                subscription.terminate()
                resolve(true)
            })
        })
        const awaitConnected = (): Promise<boolean> => new Promise(resolve => {
            if (connection.state.getValue() === "connected") {
                resolve(true)
                return
            }
            const timer = window.setTimeout(() => {
                subscription.terminate()
                resolve(false)
            }, TokenTimeoutMillis)
            const subscription = connection.state.subscribe(owner => {
                if (owner.getValue() !== "connected") {return}
                clearTimeout(timer)
                subscription.terminate()
                resolve(true)
            })
        })
        const ensureServer = (): void => {
            if (connection.mode.getValue() !== "server" || connection.state.getValue() === "off") {
                connection.connect("server")
            }
        }
        const renewToken = async (origin: Element) => {
            ensureServer()
            if (!await awaitConnected()) {
                Surface.get(origin).toast("The openDAW server is not reachable", IconSymbol.Robot)
                return
            }
            connection.renew()
        }
        const copyServerCommand = async (origin: Element) => {
            if (connection.token.isEmpty()) {
                ensureServer()
                if (!await awaitToken()) {
                    Surface.get(origin).toast("The openDAW server is not reachable", IconSymbol.Robot)
                    return
                }
            }
            await connection.token.match({
                none: () => Promise.resolve(),
                some: ({token}) => copy(serverCommand(token), origin)
            })
        }
        const localField: HTMLInputElement = (
            <input className="default input command" type="text" readOnly={true} value={LocalCommand}/>
        )
        const expiry: HTMLElement = <span className="note"/>
        const serverPanel: HTMLElement = (
            <div className="panel">
                <span className="note">Data passes through the openDAW server, nothing is stored.</span>
                <label>Copy the command and run it once in your terminal</label>
                <div className="buttons">
                    <Button lifecycle={lifecycle}
                            onClick={() => copyServerCommand(expiry).finally()}
                            appearance={{framed: true, tooltip: "Contains your personal token, keep it private"}}>
                        <span>Copy Command</span>
                    </Button>
                    <Button lifecycle={lifecycle} disabled={noRenew} onClick={() => renewToken(expiry).finally()}
                            appearance={{framed: true, tooltip: "Replace the token, the old command stops working"}}>
                        <span>New Token</span>
                    </Button>
                </div>
                {expiry}
            </div>
        )
        const localPanel: HTMLElement = (
            <div className="panel">
                <span className="note">Runs on this computer, nothing leaves it.</span>
                <label>Run this once in your terminal</label>
                <div className="row">
                    {localField}
                    <Button lifecycle={lifecycle} onClick={() => copy(localField.value, localField).finally()}
                            appearance={{framed: true}}>
                        <span>Copy</span>
                    </Button>
                </div>
            </div>
        )
        const update = () => {
            const server = mode.getValue() === "server"
            const token = connection.token.unwrapOrNull()
            serverPanel.classList.toggle("inactive", !server)
            localPanel.classList.toggle("inactive", server)
            expiry.textContent = isDefined(token)
                ? `Your token is valid until ${new Date(token.expires).toLocaleDateString()}.`
                : "Copy Command connects and creates your personal token."
            noRenew.setValue(!isDefined(token))
        }
        lifecycle.ownAll(
            mode.subscribe(update),
            connection.token.subscribe(update),
            connection.state.subscribe(update),
            connection.mode.subscribe(update)
        )
        const dialog: HTMLDialogElement = (
            <Dialog headline="Connect Agent"
                    icon={IconSymbol.Robot}
                    cancelable={true}
                    buttons={[
                        {text: "Done", onClick: handler => handler.close()},
                        {
                            text: "Connect", primary: true, onClick: handler => {
                                connection.connect(mode.getValue())
                                handler.close()
                            }
                        }
                    ]}>
                <div className={className}>
                    <p>An AI agent like Claude Code writes and runs scripts in this studio.</p>
                    <RadioGroup lifecycle={lifecycle}
                                className="mode"
                                model={mode}
                                elements={[
                                    {value: "server", element: <span>openDAW Server</span>},
                                    {value: "local", element: <span>Local Relay</span>}
                                ]}/>
                    <div className="panels">
                        {serverPanel}
                        {localPanel}
                    </div>
                </div>
            </Dialog>
        )
        dialog.addEventListener("close", () => lifecycle.terminate())
        update()
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
    }
}
