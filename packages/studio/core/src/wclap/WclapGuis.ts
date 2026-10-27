import {isDefined, Notifier, Procedure, Size, Subscription, Terminable} from "@opendaw/lib-std"

// Open plugin webviews by device uuid: the engine's `wclapSend` lands in every registered receiver
export namespace WclapGuis {
    const guis = new Map<string, Set<Procedure<ArrayBuffer>>>()

    export const register = (uuid: string, receiver: Procedure<ArrayBuffer>): Terminable => {
        const receivers = guis.get(uuid) ?? new Set<Procedure<ArrayBuffer>>()
        receivers.add(receiver)
        guis.set(uuid, receivers)
        return {
            terminate: () => {
                const current = guis.get(uuid)
                if (!isDefined(current) || !current.delete(receiver) || current.size > 0) {return}
                guis.delete(uuid)
                hovered.delete(uuid)
            }
        }
    }

    export const deliver = (uuid: string, bytes: ArrayBuffer): void => guis.get(uuid)?.forEach(receiver => receiver(bytes))

    // clap.param-hovered per device, -1 = none
    const hovered = new Map<string, number>()
    const notifier = new Notifier<{ uuid: string, paramId: number }>()
    export const hover = (uuid: string, paramId: number): void => {
        hovered.set(uuid, paramId)
        notifier.notify({uuid, paramId})
    }
    export const hoveredParam = (uuid: string): number => hovered.get(uuid) ?? -1
    export const subscribeHovered = (uuid: string, procedure: Procedure<number>): Subscription =>
        notifier.subscribe(event => {if (event.uuid === uuid) {procedure(event.paramId)}})

    // clap.gui request_resize per device
    const resizes = new Notifier<{ uuid: string, size: Size }>()
    export const resize = (uuid: string, width: number, height: number): void => resizes.notify({uuid, size: {width, height}})
    export const subscribeResize = (uuid: string, procedure: Procedure<Size>): Subscription =>
        resizes.subscribe(event => {if (event.uuid === uuid) {procedure(event.size)}})

    // clap.gui request_show (true) and request_hide (false) per device
    const shows = new Notifier<{ uuid: string, visible: boolean }>()
    export const show = (uuid: string, visible: boolean): void => shows.notify({uuid, visible})
    export const subscribeShow = (uuid: string, procedure: Procedure<boolean>): Subscription =>
        shows.subscribe(event => {if (event.uuid === uuid) {procedure(event.visible)}})
}
