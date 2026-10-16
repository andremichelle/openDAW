import {isDefined, Nullable, Procedure, Provider} from "@opendaw/lib-std"
import {MidiAccess, MidiDevices} from "@opendaw/studio-core"
import {Shell} from "@/platform/desktop/Shell"

// MIDI for the desktop app (WKWebView has no Web MIDI): the native engine's midir devices behind the Web MIDI
// interfaces, installed as the studio's MidiAccess
export namespace NativeMidi {
    type Port = { id: string, name: string }
    type FromEngine =
        | { type: "devices", inputs: ReadonlyArray<Port>, outputs: ReadonlyArray<Port> }
        | { type: "message", id: string, data: ReadonlyArray<number> }

    class MidiPortEvent extends Event {
        constructor(readonly port: NativeMIDIPort) {super("statechange")}
    }

    class MidiMessageEvent extends Event {
        constructor(readonly data: Uint8Array) {super("midimessage")}
    }

    abstract class NativeMIDIPort extends EventTarget {
        readonly manufacturer: Nullable<string> = null
        readonly version: Nullable<string> = null
        state: MIDIPortDeviceState = "connected"
        connection: MIDIPortConnectionState = "open"
        onstatechange: Nullable<Procedure<Event>> = null

        protected constructor(readonly id: string, readonly name: string) {super()}

        open(): Promise<this> {return Promise.resolve(this)}
        close(): Promise<this> {return Promise.resolve(this)}
    }

    class NativeMIDIInput extends NativeMIDIPort implements MIDIInput {
        readonly type: MIDIPortType = "input"
        #onmidimessage: Nullable<Procedure<Event>> = null

        constructor(id: string, name: string) {super(id, name)}

        get onmidimessage(): Nullable<Procedure<Event>> {return this.#onmidimessage}
        set onmidimessage(listener: Nullable<Procedure<Event>>) {
            if (isDefined(this.#onmidimessage)) {this.removeEventListener("midimessage", this.#onmidimessage)}
            this.#onmidimessage = listener
            if (isDefined(listener)) {this.addEventListener("midimessage", listener)}
        }
    }

    class NativeMIDIOutput extends NativeMIDIPort implements MIDIOutput {
        readonly type: MIDIPortType = "output"

        constructor(id: string, name: string, readonly socket: Provider<Nullable<WebSocket>>) {super(id, name)}

        send(data: Iterable<number>, timestamp?: number): void {
            const delay = isDefined(timestamp) ? timestamp - performance.now() : 0.0
            const socket = this.socket()
            if (!isDefined(socket) || socket.readyState !== WebSocket.OPEN) {return}
            socket.send(JSON.stringify({type: "send", id: this.id, data: Array.from(data), delay}))
        }

        clear(): void {}
    }

    class NativeMIDIAccess extends EventTarget implements MIDIAccess {
        readonly inputs = new Map<string, NativeMIDIInput>()
        readonly outputs = new Map<string, NativeMIDIOutput>()
        readonly sysexEnabled = false
        onstatechange: Nullable<Procedure<Event>> = null

        update(socket: Provider<Nullable<WebSocket>>, inputs: ReadonlyArray<Port>, outputs: ReadonlyArray<Port>): void {
            const changes: Array<NativeMIDIPort> = []
            const sync = <P extends NativeMIDIPort>(map: Map<string, P>, ports: ReadonlyArray<Port>, create: (port: Port) => P) => {
                map.forEach((existing, id) => {
                    if (ports.some(port => port.id === id)) {return}
                    map.delete(id)
                    existing.state = "disconnected"
                    changes.push(existing)
                })
                ports.filter(port => !map.has(port.id)).forEach(port => {
                    const created = create(port)
                    map.set(port.id, created)
                    changes.push(created)
                })
            }
            sync(this.inputs, inputs, ({id, name}) => new NativeMIDIInput(id, name))
            sync(this.outputs, outputs, ({id, name}) => new NativeMIDIOutput(id, name, socket))
            changes.forEach(port => {
                const event = new MidiPortEvent(port)
                this.dispatchEvent(event)
                this.onstatechange?.(event)
            })
        }
    }

    export const install = (): void => {
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const access = new NativeMIDIAccess()
        const current: { socket: Nullable<WebSocket> } = {socket: null}
        const socketProvider = () => current.socket
        // the engine process may still be starting; a dropped connection is reopened
        const ready = new Promise<NativeMIDIAccess>(resolve => {
            const connect = (attempt: number): void => {
                const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/midi?token=${engine.token}`)
                current.socket = socket
                socket.onclose = () => {
                    current.socket = null
                    if (attempt >= 20) {
                        resolve(access)
                        return
                    }
                    setTimeout(() => connect(attempt + 1), 250)
                }
                socket.onmessage = (event: MessageEvent<string>) => {
                    const message = JSON.parse(event.data) as FromEngine
                    if (message.type === "devices") {
                        access.update(socketProvider, message.inputs, message.outputs)
                        resolve(access)
                    } else if (message.type === "message") {
                        access.inputs.get(message.id)?.dispatchEvent(new MidiMessageEvent(Uint8Array.from(message.data)))
                    }
                }
            }
            connect(0)
        })
        MidiAccess.install({
            requiresPermission: false,
            available: true,
            request: () => ready,
            isInput: (value: unknown): value is MIDIInput => value instanceof NativeMIDIInput
        })
        // no permission prompt to wait for, the devices are there from the start
        void MidiDevices.requestPermission()
    }
}
