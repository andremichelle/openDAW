import {BoxGraph, Field} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {BoxIO, MIDIOutputBox, MIDIOutputDeviceBox} from "@opendaw/studio-boxes"

export const migrateMIDIOutputDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, deviceBox: MIDIOutputDeviceBox, outputMidiDevices: Field): void => {
    const id = deviceBox.deprecatedDevice.id.getValue()
    const label = deviceBox.deprecatedDevice.label.getValue()
    const delay = deviceBox.deprecatedDelay.getValue()
    if (id !== "") {
        console.debug("Migrate 'MIDIOutputDeviceBox' to MIDIOutputBox")
        boxGraph.beginTransaction()
        deviceBox.device.refer(
            MIDIOutputBox.create(boxGraph, UUID.generate(), box => {
                box.id.setValue(id)
                box.label.setValue(label)
                box.delayInMs.setValue(delay)
                box.root.refer(outputMidiDevices)
            }).device
        )
        deviceBox.deprecatedDevice.id.setValue("")
        deviceBox.deprecatedDevice.label.setValue("")
        boxGraph.endTransaction()
    }
}
