import {Option} from "@opendaw/lib-std"

// Where MIDI devices come from: the browser's Web MIDI (the default) or a host with its own devices (the desktop app)
export interface MidiAccess {
    // the browser asks the user before it lists any device
    readonly requiresPermission: boolean
    // whether MIDI is available at all
    readonly available: boolean
    request(): Promise<MIDIAccess>
    // an external input of this access (the software keyboard is not one)
    isInput(value: unknown): value is MIDIInput
}

export namespace MidiAccess {
    export const Web: MidiAccess = {
        requiresPermission: true,
        get available(): boolean {return "requestMIDIAccess" in navigator},
        request: (): Promise<MIDIAccess> => navigator.requestMIDIAccess({sysex: false}),
        isInput: (value: unknown): value is MIDIInput => typeof MIDIInput !== "undefined" && value instanceof MIDIInput
    }

    const state: { strategy: Option<MidiAccess> } = {strategy: Option.None}

    export const install = (strategy: MidiAccess): void => {state.strategy = Option.wrap(strategy)}
    export const current = (): MidiAccess => state.strategy.unwrapOrElse(Web)
}
