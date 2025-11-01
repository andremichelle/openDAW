import css from "./DeviceSelector.sass?inline"
import {
    asInstanceOf,
    clamp,
    DefaultObservableValue,
    int,
    isNotNull,
    Lifecycle,
    Strings,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@/ui/model/menu-item"
import {Colors, MidiDevices, Project} from "@opendaw/studio-core"
import {MIDIOutputDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {MIDIOutputBox, RootBox} from "@opendaw/studio-boxes"
import {Html} from "@opendaw/lib-dom"
import {NumberInput} from "@/ui/components/NumberInput"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "DeviceSelector")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: MIDIOutputDeviceBoxAdapter
}

const getOrCreateMIDIOutput = (rootBox: RootBox, output: MIDIOutput): MIDIOutputBox => {
    return rootBox.outputMidiDevices.pointerHub
            .incoming()
            .map(({box}) => asInstanceOf(box, MIDIOutputBox))
            .find((box) => box.id.getValue() === output.id)
        ?? MIDIOutputBox.create(rootBox.graph, UUID.generate(), box => {
            box.id.setValue(output.id)
            box.label.setValue(output.name ?? "Unnamed")
            box.root.refer(rootBox.outputMidiDevices)
        })
}

export const DeviceSelector = ({lifecycle, project, adapter}: Construct) => {
    const {editing, rootBox} = project
    const {box: {device}, midiDevice} = adapter
    const deviceLabelClass = Inject.classList("device-label")
    const deviceIdObserver = (requestedId: string) => {
        const optDevice = MidiDevices.externalOutputDevices()
            .map(devices => devices.find(device => device.id === requestedId))
        deviceLabelClass.toggle("not-available", optDevice.isEmpty() && requestedId !== "")
    }
    const delayInMs = lifecycle.own(new DefaultObservableValue<int>(0))
    const sendTransportMessages = lifecycle.own(new DefaultObservableValue<boolean>(true))
    const deviceSubscription = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        midiDevice.catchupAndSubscribe(opt => {
            deviceSubscription.terminate()
            opt.match({
                none: () => {
                    delayInMs.setValue(0)
                    sendTransportMessages.setValue(true)
                },
                some: device => {
                    deviceSubscription.ownAll(
                        device.delayInMs.catchupAndSubscribe(owner => delayInMs.setValue(owner.getValue())),
                        device.sendTransportMessages.catchupAndSubscribe(owner => sendTransportMessages.setValue(owner.getValue()))
                    )
                }
            })
        }),
        delayInMs.catchupAndSubscribe(owner => midiDevice
            .ifSome(device => editing.modify(() => device.delayInMs.setValue(owner.getValue())))),
        sendTransportMessages.catchupAndSubscribe(owner => midiDevice
            .ifSome(device => editing.modify(() => device.sendTransportMessages.setValue(owner.getValue()))))
    )
    return (
        <div className={className}>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                parent.addMenuItem(...MidiDevices.externalOutputDevices().match({
                    none: () => [MenuItem.default({label: "No MIDI requested.", selectable: false})],
                    some: outputs => outputs.length === 0
                        ? [MenuItem.default({label: "No device found.", selectable: false})]
                        : outputs.map(output => MenuItem.default({
                            label: output.name ?? "Unnamed device",
                            checked: output.id === device.targetVertex
                                .mapOr(({box}) => asInstanceOf(box, MIDIOutputBox).id.getValue(), "")
                        }).setTriggerProcedure(() => editing.modify(() => {
                            const disconnectedDevice = midiDevice.unwrapOrNull()
                            device.refer(getOrCreateMIDIOutput(rootBox, output).device)
                            if (isNotNull(disconnectedDevice) && disconnectedDevice.device.pointerHub.size() === 0) {
                                disconnectedDevice.delete()
                            }
                        }))).concat(MenuItem.default({
                            label: `Remove ${midiDevice.match({
                                none: () => "MIDI device",
                                some: device => device.label.getValue()
                            })}`
                        }).setTriggerProcedure(() => editing.modify(() => {
                            const disconnectedDevice = midiDevice.unwrapOrNull()
                            device.defer()
                            if (isNotNull(disconnectedDevice) && disconnectedDevice.device.pointerHub.size() === 0) {
                                disconnectedDevice.delete()
                            }
                        })))
                })))} style={{width: "100%"}} appearance={{color: Colors.dark, activeColor: Colors.gray}}>
                <div className={deviceLabelClass}
                     onInit={element => {
                         const subscriber = lifecycle.own(new Terminator())
                         lifecycle.ownAll(
                             adapter.midiDevice.catchupAndSubscribe(opt => {
                                 subscriber.terminate()
                                 opt.match<unknown>({
                                     none: () => {
                                         element.textContent = "No device selected"
                                         deviceIdObserver("")
                                     },
                                     some: output => subscriber.ownAll(
                                         output.id.catchupAndSubscribe(owner => deviceIdObserver(owner.getValue())),
                                         output.label.catchupAndSubscribe(owner =>
                                             element.textContent = Strings.nonEmpty(
                                                 owner.getValue(), "No device selected"))
                                     )
                                 })
                             })
                         )
                     }}/>
            </MenuButton>
            <div className="controls">
                <span>Delay (ms):</span>
                <NumberInput lifecycle={lifecycle}
                             model={delayInMs}
                             guard={{guard: (value: int): int => clamp(value, 0, 500)}}
                />
                <div/>
                <span>Send Transport:</span>
                <Checkbox lifecycle={lifecycle} model={EditWrapper.forValue(editing, sendTransportMessages)}>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
            </div>
        </div>
    )
}