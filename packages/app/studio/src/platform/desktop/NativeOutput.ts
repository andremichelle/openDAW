import {DefaultObservableValue, int, isDefined, Nullable, Option, tryCatch} from "@opendaw/lib-std"
import {AudioOutputBackend, AudioOutputDevice, OutputDevice} from "@/audio/AudioOutputDevice"
import {Shell} from "@/platform/desktop/Shell"

// The native engine's output device and buffer size; the choice is kept on this machine and applied at every launch
export namespace NativeOutput {
    const StorageKey = "native-audio-output"
    const BufferSizes: ReadonlyArray<int> = [64, 128, 256, 512, 1024]

    type FromEngine = { type: "output", devices: ReadonlyArray<string>, device: string, buffer: int }
    type Choice = { device: string, buffer: int }

    const readChoice = (): Choice => {
        const {status, value} = tryCatch(() => JSON.parse(localStorage.getItem(StorageKey) ?? "null") as Nullable<Choice>)
        return status === "success" && isDefined(value) ? value : {device: "", buffer: 128}
    }

    const toDevice = (name: string): OutputDevice => ({deviceId: name, label: name})

    export const install = (): void => {
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const current = new DefaultObservableValue<Option<OutputDevice>>(Option.None)
        const bufferSize = new DefaultObservableValue<int>(readChoice().buffer)
        const state: { socket: Nullable<WebSocket>, devices: ReadonlyArray<string> } = {socket: null, devices: []}
        const choose = (choice: Choice): void => {
            localStorage.setItem(StorageKey, JSON.stringify(choice))
            state.socket?.send(JSON.stringify({type: "output", ...choice}))
        }
        const connect = (attempt: number): void => {
            const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/audio?token=${engine.token}`)
            socket.onopen = () => {
                state.socket = socket
                socket.send(JSON.stringify({type: "output", ...readChoice()}))
            }
            socket.onclose = () => {
                state.socket = null
                if (attempt < 20) {setTimeout(() => connect(attempt + 1), 250)}
            }
            socket.onmessage = (event: MessageEvent<string>) => {
                const message = JSON.parse(event.data) as FromEngine
                state.devices = message.devices
                current.setValue(Option.wrap(toDevice(message.device)))
                bufferSize.setValue(message.buffer)
            }
        }
        connect(0)
        const backend: AudioOutputBackend = {
            current,
            bufferSize,
            bufferSizes: BufferSizes,
            devices: () => state.devices.map(toDevice),
            choose: (device, frames) => choose({device: device.deviceId, buffer: frames})
        }
        AudioOutputDevice.install(backend)
    }
}
