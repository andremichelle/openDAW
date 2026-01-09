import {Browser} from "./browser"

export namespace Keyboard {
    export const isControlKey = ({ctrlKey, metaKey}: {
        ctrlKey: boolean,
        metaKey: boolean
    }) => Browser.isMacOS() ? metaKey : ctrlKey
    export const isDelete = (event: KeyboardEvent) => event.code === "Delete" || event.code === "Backspace"
    export const isSelectAll = (event: KeyboardEvent) => isControlKey(event) && !event.shiftKey && event.code === "KeyA"
    export const isDeselectAll = (event: KeyboardEvent) => isControlKey(event) && event.shiftKey && event.code === "KeyA"
}