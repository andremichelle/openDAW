import {AnimationFrame} from "@opendaw/lib-dom"
import {Terminable, ValueOwner} from "@opendaw/lib-std"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"

export const setupShadertoyRunner = (runner: ShadertoyRunner,
                                     canvas: HTMLCanvasElement,
                                     highres: ValueOwner<boolean>): Terminable => {
    runner.resetTime()
    return AnimationFrame.add(() => {
        const scale = highres.getValue() ? devicePixelRatio : 1
        canvas.width = canvas.clientWidth * scale
        canvas.height = canvas.clientHeight * scale
        runner.render()
    })
}