import {
    asDefined,
    asInstanceOf,
    DefaultObservableValue,
    Errors,
    int,
    MutableObservableOption,
    isDefined,
    Notifier,
    Nullable,
    Observer,
    Option,
    Procedure,
    RuntimeNotifier,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
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
    deliver: Procedure<unitValue>
    subscription: Subscription
}

const AnyChannel = -1

export type MIDIMappableField = PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>

// will be part of MIDI preferences. Should not filter for the device-id
// because it is different for the same hardware in different browsers.
const respectDeviceID = false

export class MIDILearning implements Terminable {
    readonly #terminator = new Terminator()

    readonly #project: Project
    readonly #connections: SortedSet<Address, MIDIConnection>
    readonly #changes: Notifier<void>

    readonly mapMode: DefaultObservableValue<boolean>
    readonly mapTarget: MutableObservableOption<MIDIMappableField>

    #optMIDIContollers: Option<Field<Pointers.MIDIControllers>> = Option.None
    #optFieldSubscription: Option<Subscription> = Option.None

    constructor(project: Project) {
        this.#project = project
        this.#connections = Address.newSet<MIDIConnection>(connection => connection.box.address)
        this.#changes = this.#terminator.own(new Notifier<void>())
        this.mapMode = this.#terminator.own(new DefaultObservableValue<boolean>(false))
        this.mapTarget = this.#terminator.own(new MutableObservableOption<MIDIMappableField>())
        this.#terminator.own(this.mapMode.subscribe(owner => {
            if (!owner.getValue()) {this.mapTarget.clear()}
        }))
        this.#terminator.own(MidiDevices.subscribeMessageEvents((event: MIDIMessageEvent) => {
            if (event.data === null) {return}
            this.receive(event.data, event.target instanceof MIDIInput ? event.target.id : "")
        }))
    }

    followUser(field: Field<Pointers.MIDIControllers>): void {
        this.#killAllConnections()
        this.#optFieldSubscription.ifSome(subscription => subscription.terminate())
        this.#optFieldSubscription = Option.None
        this.#optMIDIContollers = Option.wrap(field)
        this.#optFieldSubscription = Option.wrap(field.pointerHub.catchupAndSubscribe({
            onAdded: ({box: anyBox}) => {
                const box = asInstanceOf(anyBox, MIDIControllerBox)
                const {subscription, deliver} = this.#registerMIDIControllerBox(box)
                this.#connections.add({box, subscription, deliver})
                this.#changes.notify()
            },
            onRemoved: ({box: {address}}) => {
                this.#connections.removeByKey(address).subscription.terminate()
                this.#changes.notify()
            }
        }))
    }

    get numberOfConnections(): int {return this.#connections.size()}

    controllerBoxes(): ReadonlyArray<MIDIControllerBox> {return this.#connections.values().map(({box}) => box)}

    subscribeChanges(observer: Observer<void>): Subscription {return this.#changes.subscribe(observer)}

    receive(data: Uint8Array, deviceId: string): void {
        if (!MidiData.isController(data)) {return}
        const channel = MidiData.readChannel(data)
        const controlId = MidiData.readParam1(data)
        if (this.mapMode.getValue()) {
            this.mapTarget.ifSome(field => {
                const bound = this.#findConnectionByParameterAddress(field.address).mapOr(({box}) =>
                    box.controlId.getValue() === controlId && box.deviceChannel.getValue() === channel, false)
                if (!bound) {this.#bind(field, deviceId, channel, controlId)}
                this.mapTarget.clear()
            })
        }
        this.#connections.values().forEach(({box, deliver}) => {
            if (box.controlId.getValue() !== controlId) {return}
            const boxChannel = box.deviceChannel.getValue()
            if (boxChannel !== AnyChannel && boxChannel !== channel) {return}
            if (respectDeviceID && box.deviceId.getValue() !== deviceId) {return}
            deliver(MidiData.asValue(data))
        })
    }

    hasMidiConnection(address: Address): boolean {
        return this.#findConnectionByParameterAddress(address).nonEmpty()
    }

    forgetMidiConnection(address: Address) {
        const connection = this.#findConnectionByParameterAddress(address).unwrap("No connection to forget")
        this.#project.editing.modify(() => asDefined(connection).box.delete())
    }

    async learnMIDIControls(field: MIDIMappableField) {
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
        learnLifecycle.own(MidiDevices.subscribeMessageEvents((event: MIDIMessageEvent) => {
            const data = event.data
            if (data === null) {return}
            const deviceId = event.target instanceof MIDIInput ? event.target.id : ""
            if (MidiData.isController(data)) {
                learnLifecycle.terminate()
                abortController.abort(Errors.AbortError)
                this.#bind(field, deviceId, MidiData.readChannel(data), MidiData.readParam1(data))
                this.receive(data, deviceId)
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

    createMapping(field: MIDIMappableField, init: Procedure<MIDIControllerBox>): MIDIControllerBox {
        const midiControllersField = this.#optMIDIContollers.unwrap("No user accepting midi controls")
        const existing = this.#findConnectionByParameterAddress(field.address)
        return this.#project.editing.modify(() => {
            existing.ifSome(({box}) => box.delete())
            return MIDIControllerBox.create(this.#project.boxGraph, UUID.generate(), box => {
                box.controllers.refer(midiControllersField)
                box.parameter.refer(field)
                init(box)
            })
        }).unwrap("Could not create MIDIControllerBox")
    }

    #bind(field: MIDIMappableField, deviceId: string, channel: int, controlId: int): MIDIControllerBox {
        return this.createMapping(field, box => {
            box.deviceId.setValue(deviceId)
            box.deviceChannel.setValue(channel)
            box.controlId.setValue(controlId)
        })
    }

    #registerMIDIControllerBox(box: MIDIControllerBox): {subscription: Subscription, deliver: Procedure<unitValue>} {
        const address = box.parameter.targetAddress.unwrap("No parameter address")
        const adapter = this.#project.parameterFieldAdapters.get(address)
        const {editing} = this.#project
        const registration = adapter.registerMidiControl()
        let pendingValue: Nullable<unitValue> = null
        const update = (value: unitValue) => editing.modify(() => adapter.setUnitValue(value), false)
        const deliver = (value: unitValue) => {
            if (isDefined(pendingValue)) {
                pendingValue = value
                return
            }
            update(value)
            pendingValue = value
            AnimationFrame.once(() => {
                if (isDefined(pendingValue)) {
                    update(pendingValue)
                    pendingValue = null
                }
            })
        }
        return {
            subscription: {
                terminate: () => {
                    pendingValue = null
                    registration.terminate()
                }
            }, deliver
        }
    }

    #killAllConnections(): void {
        this.#connections.forEach(({subscription}) => subscription.terminate())
        this.#connections.clear()
    }

    #findConnectionByParameterAddress(address: Address): Option<MIDIConnection> {
        return Option.wrap(this.#connections.values().find(({box}) =>
            box.parameter.targetAddress.mapOr(target => target.equals(address), false)))
    }
}