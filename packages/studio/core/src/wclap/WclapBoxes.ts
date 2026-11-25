import {WclapDeviceBox, WclapInstrumentBox, WclapMidiEffectBox} from "@opendaw/studio-boxes"

// The boxes hosting a WebCLAP plugin, they share url, clap-id, state, parameters and plugin-state
export namespace WclapBoxes {
    export type Any = WclapDeviceBox | WclapInstrumentBox | WclapMidiEffectBox

    export const is = (box: unknown): box is Any =>
        box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox || box instanceof WclapMidiEffectBox
}
