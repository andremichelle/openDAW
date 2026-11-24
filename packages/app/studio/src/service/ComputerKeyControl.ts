import {Terminable} from "@opendaw/lib-std"
import {Events, Keyboard, Shortcut} from "@opendaw/lib-dom"
import {MIDILearning} from "@opendaw/studio-core"
import {Surface} from "@/ui/surface/Surface"

export namespace ComputerKeyControl {
    export const install = (midiLearning: MIDILearning): Terminable => {
        const pressed = new Set<string>()
        const release = (code: string) => {
            if (pressed.delete(code)) {midiLearning.receiveKey(code, false)}
        }
        return Terminable.many(
            Surface.subscribeKeyboard("keydown", event => {
                if (event.repeat || Events.isTextInput(event.target)) {return}
                if (Keyboard.isControlKey(event) || event.shiftKey || event.altKey) {return}
                const code = Shortcut.resolveCode(event)
                if (midiLearning.receiveKey(code, true)) {
                    event.preventDefault()
                    pressed.add(code)
                }
            }),
            Surface.subscribeKeyboard("keyup", event => release(Shortcut.resolveCode(event)), Number.MAX_SAFE_INTEGER),
            Events.subscribe(window, "blur", () => Array.from(pressed).forEach(release))
        )
    }
}
