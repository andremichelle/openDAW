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
import {AnimationFrame, Events, Key, Keyboard, Shortcut, ShortcutManager} from "@opendaw/lib-dom"
import {MIDIControllerBox} from "@opendaw/studio-boxes"
import {MIDIMappingTransform} from "./MIDIMappingTransform"
import {MIDIMappingState} from "./MIDIMappingState"

interface MIDIConnection {
    box: MIDIControllerBox
    deliver: Procedure<int>
    subscription: Subscription
}

const AnyChannel = -1

export type MIDIMappableField = PrimitiveField<PrimitiveValues, Pointers.MIDIControl | Pointers>

const isKeyBox = (box: MIDIControllerBox): boolean => box.keyCode.getValue() !== ""

const accepts = (box: MIDIControllerBox, deviceId: string, channel: int, controlId: int): boolean => {
    if (isKeyBox(box)) {return false}
    if (box.controlId.getValue() !== controlId) {return false}
    const boxChannel = box.deviceChannel.getValue()
    if (boxChannel !== AnyChannel && boxChannel !== channel) {return false}
    const filterDeviceId = box.filterDeviceId.getValue()
    return filterDeviceId === "" || filterDeviceId === deviceId
}

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
            if (!isDefined(event.data)) {return}
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

    get numberOfConnections(): int {return this.controllerBoxes().length}

    controllerBoxes(): ReadonlyArray<MIDIControllerBox> {
        return this.#connections.values().map(({box}) => box).filter(box => !isKeyBox(box))
    }

    subscribeChanges(observer: Observer<void>): Subscription {return this.#changes.subscribe(observer)}

    receive(data: Uint8Array, deviceId: string): void {
        if (!MidiData.isController(data)) {return}
        const channel = MidiData.readChannel(data)
        const controlId = MidiData.readParam1(data)
        const value = MidiData.readParam2(data)
        if (this.mapMode.getValue()) {
            this.mapTarget.ifSome(field => {
                const bound = this.#findConnectionByParameterAddress(field.address)
                    .mapOr(({box}) => accepts(box, deviceId, channel, controlId), false)
                if (!bound) {this.#bind(field, deviceId, channel, controlId)}
                this.mapTarget.clear()
            })
        }
        this.#connections.values()
            .filter(({box}) => accepts(box, deviceId, channel, controlId))
            .forEach(({deliver}) => deliver(value))
    }

    receiveKey(code: string, pressed: boolean): boolean {
        const connections = this.#connections.values().filter(({box}) => box.keyCode.getValue() === code)
        connections.forEach(({deliver}) => deliver(pressed ? 127 : 0))
        return connections.length > 0
    }

    hasMidiConnection(address: Address): boolean {
        return this.#findConnectionByParameterAddress(address).mapOr(({box}) => !isKeyBox(box), false)
    }

    hasKeyConnection(address: Address): boolean {
        return this.#findConnectionByParameterAddress(address).mapOr(({box}) => isKeyBox(box), false)
    }

    forgetMidiConnection(address: Address) {
        const connection = this.#findConnectionByParameterAddress(address).unwrap("No connection to forget")
        this.#project.editing.modify(() => asDefined(connection).box.delete())
    }

    forgetKeyConnection(address: Address) {this.forgetMidiConnection(address)}

    bindKey(field: MIDIMappableField, code: string): MIDIControllerBox {
        return this.createMapping(field, box => box.keyCode.setValue(code))
    }

    async learnKey(field: MIDIMappableField) {
        if (this.#optMIDIContollers.isEmpty()) {
            return RuntimeNotifier.info({headline: "Learn Key...", message: "No user accepting key controls."})
        }
        const learnLifecycle = this.#terminator.spawn()
        const abortController = new AbortController()
        learnLifecycle.own(Events.subscribe(window, "keydown", (event: KeyboardEvent) => {
            if (event.code === Key.Escape || event.repeat) {return}
            const shortcut = Shortcut.fromEvent(event)
            if (shortcut.isEmpty() || Keyboard.isControlKey(event) || event.shiftKey || event.altKey) {return}
            event.preventDefault()
            event.stopImmediatePropagation()
            learnLifecycle.terminate()
            abortController.abort(Errors.AbortError)
            const key = shortcut.unwrap("shortcut")
            if (ShortcutManager.get().hasConflict(key)) {
                RuntimeNotifier.info({
                    headline: "Learn Key...",
                    message: `'${key.format().join("")}' is already used by a shortcut.`
                }).finally()
            } else {
                this.bindKey(field, key.code)
            }
        }, {capture: true}))
        return RuntimeNotifier.info({
            headline: "Learn Key...",
            message: "Press a key on your computer keyboard...",
            okText: "Cancel",
            abortSignal: abortController.signal
        }).then(() => learnLifecycle.terminate(), Errors.CatchAbort)
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
            if (!isDefined(data)) {return}
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
        return this.#project.editing.modify(() => this.#findConnectionByParameterAddress(field.address).match({
            none: () => MIDIControllerBox.create(this.#project.boxGraph, UUID.generate(), box => {
                box.controllers.refer(midiControllersField)
                box.parameter.refer(field)
                init(box)
            }),
            some: ({box}) => {
                box.keyCode.setValue("")
                init(box)
                return box
            }
        })).unwrap("Could not create MIDIControllerBox")
    }

    #bind(field: MIDIMappableField, deviceId: string, channel: int, controlId: int): MIDIControllerBox {
        return this.createMapping(field, box => {
            box.deviceId.setValue(deviceId)
            if (box.filterDeviceId.getValue() !== "") {box.filterDeviceId.setValue(deviceId)}
            box.deviceChannel.setValue(channel)
            box.controlId.setValue(controlId)
        })
    }

    #registerMIDIControllerBox(box: MIDIControllerBox): {subscription: Subscription, deliver: Procedure<int>} {
        const address = box.parameter.targetAddress.unwrap("No parameter address")
        const adapter = this.#project.parameterFieldAdapters.get(address)
        const {editing} = this.#project
        const registration = adapter.registerMidiControl()
        const state = new MIDIMappingState()
        let pendingValue: Nullable<unitValue> = null
        const update = (value: unitValue) => {
            editing.modify(() => adapter.setUnitValue(value), false)
            state.lastApplied = adapter.getUnitValue()
        }
        const deliver = (value: int) => {
            const current = pendingValue ?? adapter.getUnitValue()
            MIDIMappingTransform.apply({
                min: box.min.getValue(),
                max: box.max.getValue(),
                takeover: box.takeover.getValue(),
                encoding: box.encoding.getValue()
            }, state, value, current).ifSome(next => {
                if (isDefined(pendingValue)) {
                    pendingValue = next
                    return
                }
                update(next)
                pendingValue = next
                AnimationFrame.once(() => {
                    if (isDefined(pendingValue)) {
                        update(pendingValue)
                        pendingValue = null
                    }
                })
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