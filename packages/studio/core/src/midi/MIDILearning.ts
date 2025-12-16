import {
    asDefined,
    asInstanceOf,
    EmptyExec,
    Errors,
    isNotNull,
    Nullable,
    Option,
    Procedure,
    RuntimeNotifier,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Address, Field, PrimitiveField, PrimitiveValues} from "@opendaw/lib-box"
import {MidiData} from "@opendaw/lib-midi"
import {Pointers} from "@opendaw/studio-enums"
import {Project} from "../project"
import {MidiDevices} from "./MidiDevices"
import {AnimationFrame} from "@opendaw/lib-dom"
import {MIDIControllerBox} from "@opendaw/studio-boxes"

interface MIDIConnection {
    box: MIDIControllerBox
    handleEvent: Procedure<MIDIMessageEvent>
    subscription: Subscription
}

// will be part of MIDI preferences. Should not filter for the device-id
// because it is different for the same hardware in different browsers.
const respectDeviceID = false

export class MIDILearning implements Terminable {
    readonly #terminator = new Terminator()

    readonly #project: Project
    readonly #connections: SortedSet<Address, MIDIConnection>

    #optMIDIContollers: Option<Field<Pointers.MIDIControllers>> = Option.None
    #optFieldSubscription: Option<Subscription> = Option.None

    constructor(project: Project) {
        this.#project = project
        this.#connections = Address.newSet<MIDIConnection>(connection => connection.box.address)
    }

    followUser(field: Field<Pointers.MIDIControllers>): void {
        this.#killAllConnections()
        this.#optFieldSubscription.ifSome(subscription => subscription.terminate())
        this.#optFieldSubscription = Option.None
        this.#optMIDIContollers = Option.wrap(field)
        this.#optFieldSubscription = Option.wrap(field.pointerHub.catchupAndSubscribe({
            onAdded: ({box: anyBox}) => {
                if (MidiDevices.get().isEmpty() && MidiDevices.canRequestMidiAccess()) {
                    MidiDevices.requestPermission().then(EmptyExec, EmptyExec)
                }
                const box = asInstanceOf(anyBox, MIDIControllerBox)
                const {subscription, handleEvent} = this.#registerMIDIControllerBox(box)
                this.#connections.add({box, subscription, handleEvent})
            },
            onRemoved: ({box: {address}}) => this.#connections.removeByKey(address).subscription.terminate()
        }))
    }

    hasMidiConnection(address: Address): boolean {
        return this.#findConnectionByParameterAddress(address).nonEmpty()
    }

    forgetMidiConnection(address: Address) {
        const connection = this.#findConnectionByParameterAddress(address).unwrap("No connection to forget")
        this.#project.editing.modify(() => asDefined(connection).box.delete())
    }

    async learnMIDIControls(field: PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>) {
        if (this.#optMIDIContollers.isEmpty()) {
            return RuntimeNotifier.info({
                headline: "Learn Midi Controller...",
                message: "No user accepting midi controls."
            })
        }
        if (!MidiDevices.canRequestMidiAccess()) {return}
        await MidiDevices.requestPermission()
        const learnLifecycle = this.#terminator.spawn()
        const abortController = new AbortController()
        // TODO subscribeMessageEvents is not really suffient, because it does not distinguish between midi devices.
        learnLifecycle.own(MidiDevices.subscribeMessageEvents((event: MIDIMessageEvent) => {
            const data = event.data
            if (data === null) {return}
            const deviceId = event.target instanceof MIDIInput ? event.target.id : ""
            if (MidiData.isController(data)) {
                learnLifecycle.terminate()
                abortController.abort(Errors.AbortError)
                const midiControllersField = this.#optMIDIContollers.unwrap()
                const {editing} = this.#project
                const optBox = editing.modify(() => MIDIControllerBox.create(this.#project.boxGraph, UUID.generate(), box => {
                    box.controllers.refer(midiControllersField)
                    box.parameter.refer(field)
                    box.deviceId.setValue(deviceId)
                    box.deviceChannel.setValue(MidiData.readChannel(data))
                    box.controlId.setValue(MidiData.readParam1(data))
                }))
                this.#connections.get(optBox.unwrap("Could not create MIDIControllerBox").address).handleEvent(event)
            }
        }))
        return RuntimeNotifier.info({
            headline: "Learn Midi Controller...",
            message: "Turn a controller on your midi-device...",
            okText: "Cancel",
            abortSignal: abortController.signal
        }).then(() => learnLifecycle.terminate(), Errors.CatchAbort)
    }

    terminate(): void {
        this.#killAllConnections()
        this.#terminator.terminate()
    }

    #registerMIDIControllerBox({
                                   parameter: {targetAddress},
                                   controlId,
                                   deviceId,
                                   deviceChannel
                               }: MIDIControllerBox): {
        subscription: Subscription,
        handleEvent: Procedure<MIDIMessageEvent>
    } {
        const address = targetAddress.unwrap("No parameter address")
        const adapter = this.#project.parameterFieldAdapters.get(address)
        const {editing} = this.#project
        const registration = adapter.registerMidiControl()
        let pendingValue: Nullable<number> = null
        const update = (value: number) => editing.modify(() => adapter.setUnitValue(value), false)
        const handleEvent = (event: MIDIMessageEvent) => {
            const data = event.data
            if (data === null) {return}
            const id = event.target instanceof MIDIInput ? event.target.id : ""
            if (MidiData.isController(data)
                && MidiData.readParam1(data) === controlId.getValue() && (!respectDeviceID || id === deviceId.getValue())) {
                const value = MidiData.asValue(data)
                if (pendingValue === null) {
                    update(value)
                    pendingValue = value
                    AnimationFrame.once(() => {
                        if (isNotNull(pendingValue)) {
                            update(pendingValue)
                            pendingValue = null
                        }
                    })
                } else {
                    pendingValue = value
                }
            }
        }
        const channel = deviceChannel.getValue() === -1 ? undefined : deviceChannel.getValue()
        const subscription = MidiDevices.subscribeMessageEvents(handleEvent, channel)
        return {
            subscription: {
                terminate: () => {
                    pendingValue = null
                    subscription.terminate()
                    registration.terminate()
                }
            }, handleEvent
        }
    }

    #killAllConnections(): void {
        this.#connections.forEach(({subscription}) => subscription.terminate())
        this.#connections.clear()
    }

    #findConnectionByParameterAddress(address: Address): Option<MIDIConnection> {
        return Option.wrap(this.#connections.values().find(({box}) => box.parameter.targetAddress.unwrap() === address))
    }
}