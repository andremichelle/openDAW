import {MenuItem} from "@opendaw/studio-core"
import {Arrays, int, isInstanceOf, Option} from "@opendaw/lib-std"
import {CaptureAudioBox} from "@opendaw/studio-boxes"
import {IconSymbol} from "@opendaw/studio-enums"
import {AudioDevices, Capture, CaptureAudio, CaptureMidi, MidiDevices} from "@opendaw/studio-core"
import {AudioUnitBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {BoxEditing} from "@opendaw/lib-box"
import {StudioService} from "@/service/StudioService"

export namespace MenuCapture {
    export const createItem = (service: StudioService,
                               audioUnitBoxAdapter: AudioUnitBoxAdapter,
                               trackBoxAdapter: TrackBoxAdapter,
                               editing: BoxEditing,
                               captureOption: Option<Capture>) => MenuItem.default({
        label: audioUnitBoxAdapter.captureBox
            .mapOr(box => isInstanceOf(box, CaptureAudioBox) ? "Capture Audio" : "Capture MIDI", ""),
        hidden: trackBoxAdapter.indexField.getValue() !== 0 || captureOption.isEmpty(),
        separatorBefore: true
    }).setRuntimeChildrenProcedure(parent => {
        if (captureOption.isEmpty()) {return}
        const capture: Capture = captureOption.unwrap()
        if (isInstanceOf(capture, CaptureAudio)) {
            parent.addMenuItem(MenuItem.header({
                label: "Audio Inputs",
                icon: IconSymbol.AudioDevice
            }))
            const devices = AudioDevices.inputs
            if (devices.length === 0) {
                parent.addMenuItem(
                    MenuItem.default({label: "Click to access external devices..."})
                        .setTriggerProcedure(() => AudioDevices.requestPermission()))
            } else {
                parent.addMenuItem(...devices
                    .map(device => MenuItem.default({
                        label: device.label,
                        checked: capture.streamDeviceId.contains(device.deviceId)
                    }).setTriggerProcedure(() => {
                        editing.modify(() =>
                            capture.deviceId.setValue(Option.wrap(device.deviceId)), false)
                        capture.armed.setValue(true)
                    })))
            }
        } else if (isInstanceOf(capture, CaptureMidi)) {
            const currentDeviceId = capture.deviceId
            const channelField = capture.captureBox.channel
            const createFilteredItem = (deviceId: Option<string>,
                                        channel: Option<int>,
                                        label: string,
                                        checked: boolean,
                                        openSoftwareKeyboard: boolean = false) => MenuItem.default({label, checked})
                .setTriggerProcedure(() => {
                    editing.modify(() => {
                        currentDeviceId.setValue(deviceId)
                        channelField.setValue(channel.unwrapOrElse(-1))
                    }, false)
                    capture.armed.setValue(true)
                    if (openSoftwareKeyboard) {
                        if (!service.isSoftwareKeyboardVisible()) {
                            service.toggleSoftwareKeyboard()
                        }
                    }
                })
            const createMIDIInputMenuItem = (device: MIDIInput, index: int, openSoftwareKeyboard: boolean = false) => {
                const optDeviceId = Option.wrap(device.id)
                const sameDevice = currentDeviceId.getValue().equals(optDeviceId)
                return MenuItem.default({
                    label: device.name ?? "Unknown", checked: sameDevice, separatorBefore: index === 0
                }).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        createFilteredItem(optDeviceId, Option.None, "All channels",
                            channelField.getValue() === -1 && sameDevice, openSoftwareKeyboard),
                        ...Arrays.create(channel =>
                            createFilteredItem(optDeviceId, Option.wrap(channel),
                                `Channel ${channel + 1}`,
                                channelField.getValue() === channel && sameDevice, openSoftwareKeyboard), 16))
                })
            }
            parent.addMenuItem(MenuItem.header({label: "Devices", icon: IconSymbol.Midi}))
            MidiDevices.externalInputDevices().match({
                none: () => {
                    parent.addMenuItem(
                        MenuItem.default({label: "Click to access external devices..."})
                            .setTriggerProcedure(() => MidiDevices.requestPermission()),
                        createMIDIInputMenuItem(MidiDevices.softwareMIDIInput, 0, true))
                },
                some: inputs => {
                    if (inputs.length === 0) {
                        parent.addMenuItem(
                            MenuItem.default({label: "No external devices found", selectable: false}),
                            createMIDIInputMenuItem(MidiDevices.softwareMIDIInput, 0, true))
                    } else {
                        parent.addMenuItem(
                            MenuItem.default({
                                label: "All devices",
                                checked: currentDeviceId.getValue().isEmpty() && channelField.getValue() === -1
                            }).setRuntimeChildrenProcedure(parent => {
                                const hasNoDevice = currentDeviceId.getValue().isEmpty()
                                parent.addMenuItem(
                                    createFilteredItem(Option.None, Option.None, "All channels", channelField.getValue() === -1 && hasNoDevice),
                                    ...Arrays.create(channel =>
                                        createFilteredItem(Option.None, Option.wrap(channel),
                                            `Channel ${channel + 1}`,
                                            channelField.getValue() === channel && hasNoDevice), 16)
                                )
                            }),
                            ...inputs.map((input, index) => createMIDIInputMenuItem(input, index, false))
                        )
                    }
                }
            })
        }
    })
}