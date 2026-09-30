import {Notifier, Procedure, Subscription, Terminable} from "@opendaw/lib-std"

// Open plugin webviews by device uuid: the engine's `wclapSend` lands in the registered receiver
export namespace WclapGuis {
    const guis = new Map<string, Procedure<ArrayBuffer>>()

    export const register = (uuid: string, receiver: Procedure<ArrayBuffer>): Terminable => {
        guis.set(uuid, receiver)
        return {
            terminate: () => {
                if (guis.get(uuid) !== receiver) {return}
                guis.delete(uuid)
                hovered.delete(uuid)
            }
        }
    }

    export const deliver = (uuid: string, bytes: ArrayBuffer): void => guis.get(uuid)?.(bytes)

    // clap.param-hovered: the parameter under the pointer in the plugin's page, -1 when none. A plugin that
    // reports one proves it implements the extension, which is what unlocks the in-window menu and value entry.
    const hovered = new Map<string, number>()
    const notifier = new Notifier<{ uuid: string, paramId: number }>()
    export const hover = (uuid: string, paramId: number): void => {
        hovered.set(uuid, paramId)
        notifier.notify({uuid, paramId})
    }
    export const hoveredParam = (uuid: string): number => hovered.get(uuid) ?? -1
    export const subscribeHovered = (uuid: string, procedure: Procedure<number>): Subscription =>
        notifier.subscribe(event => {if (event.uuid === uuid) {procedure(event.paramId)}})
}
