import css from "./ShadertoyPreview.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {
    asInstanceOf,
    DefaultObservableValue,
    isAbsent,
    Lifecycle,
    Terminable,
    Terminator,
    tryCatch
} from "@moises-ai/lib-std"
import {createElement, Frag, replaceChildren} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"
import {ShadertoyBox} from "@moises-ai/studio-boxes"
import {ShadertoyLogo} from "@/ui/devices/panel/ShadertoyLogo"
import {setupShadertoyRunner} from "@/ui/shadertoy/runner-setup"

const className = Html.adoptStyleSheet(css, "ShadertoyPreview")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const visible = new DefaultObservableValue(true)

export const ShadertoyPreview = ({lifecycle, service}: Construct) => {
    return (
        <div className={className} onInit={element => {
            const shaderLifecycle = lifecycle.own(new Terminator())
            lifecycle.own(
                service.project.rootBox.shadertoy.catchupAndSubscribe(({targetVertex}) => {
                    shaderLifecycle.terminate()
                    targetVertex.match({
                        none: () => {
                            element.classList.add("hidden")
                            return Terminable.Empty
                        },
                        some: (box) => {
                            element.classList.remove("hidden")
                            const canvas: HTMLCanvasElement = (<canvas/>)
                            replaceChildren(element, (
                                <Frag>
                                    <ShadertoyLogo onInit={logo => {
                                        shaderLifecycle.own(Events.subscribe(logo, "click",
                                            () => visible.setValue(!visible.getValue())))
                                    }}/>
                                    {canvas}
                                </Frag>
                            ))
                            const gl = canvas.getContext("webgl2")
                            if (isAbsent(gl)) {
                                element.setAttribute("data-status", "WebGL2 not supported")
                                return Terminable.Empty
                            }
                            const runner = new ShadertoyRunner(service.optShadertoyState.unwrap("no state"), gl)
                            shaderLifecycle.ownAll(
                                visible.catchupAndSubscribe(owner => canvas.classList.toggle("hidden", !owner.getValue())),
                                Events.subscribe(canvas, "click", async () => {
                                    try {
                                        if (document.fullscreenElement) {
                                            await document.exitFullscreen()
                                        } else {
                                            await canvas.requestFullscreen()
                                        }
                                    } catch { /* ignore fullscreen errors (often caused by extensions) */ }
                                })
                            )
                            const {shaderCode, highres} = asInstanceOf(box, ShadertoyBox)
                            return shaderCode.catchupAndSubscribe(code => {
                                const {status, error} = tryCatch(() => runner.compile(code.getValue()))
                                if (status === "failure") {
                                    element.setAttribute("data-status", String(error))
                                    return
                                }
                                element.removeAttribute("data-status")
                                shaderLifecycle.ownAll(setupShadertoyRunner(runner, canvas, highres))
                            })
                        }
                    })
                })
            )
        }}>
        </div>
    )
}
