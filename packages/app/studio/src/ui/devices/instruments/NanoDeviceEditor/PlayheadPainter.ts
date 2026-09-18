import {asDefined, Terminable} from "@opendaw/lib-std"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"

// Paints the read head of every playing voice from the device's positions broadcast (-1 ends the list).
export const subscribePlayheads = (receiver: LiveStreamReceiver, adapter: NanoDeviceBoxAdapter, canvas: HTMLCanvasElement): Terminable => {
    const context: CanvasRenderingContext2D = asDefined(canvas.getContext("2d"))
    return receiver.subscribeFloats(adapter.positionsAddress, positions => {
        canvas.width = canvas.clientWidth
        canvas.height = canvas.clientHeight
        adapter.file().flatMap(file => file.data).ifSome(data => {
            context.fillStyle = Colors.blue.toString()
            for (const position of positions) {
                if (position === -1) {break}
                context.fillRect(Math.round(position / data.numberOfFrames * canvas.width), 0, 1, canvas.height)
            }
        })
    })
}
