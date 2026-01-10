import css from "./ShadertoyPreview.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {asInstanceOf, isAbsent, Lifecycle, Nullable, Terminable, Terminator, tryCatch} from "@opendaw/lib-std"
import {createElement, LocalLink} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {ShadertoyRunner} from "@/ui/shadertoy/ShadertoyRunner"
import {ShadertoyBox} from "@opendaw/studio-boxes"
import {Colors} from "@opendaw/studio-enums"
import {setupShadertoyRunner} from "@/ui/shadertoy/runner-setup"

const className = Html.adoptStyleSheet(css, "ShadertoyPreview")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ShadertoyPreview = ({lifecycle, service}: Construct) => {
    const output: HTMLElement = <p className="status"/>
    return (
        <div className={className}>
            <h1>Shadertoy</h1>
            <p>
                Write GLSL shaders to create visuals for your music. The editor supports <a
                href="https://shadertoy.com/" target="shadertoy">Shadertoy</a> compatible syntax.<br/>
                MIDI data is passed to the shader if you route a MIDI output to the <span
                style={{color: Colors.cream.toString()}}>Shadertoy</span> MIDI device. Read the <LocalLink
                href="/manuals/shadertoy">manual</LocalLink>.
            </p>
            <div className="canvas-wrapper">
                <canvas onInit={canvas => {
                    const gl: Nullable<WebGL2RenderingContext> = canvas.getContext("webgl2")
                    if (isAbsent(gl)) {
                        output.textContent = "WebGL2 not supported"
                        return
                    }
                    const runner = new ShadertoyRunner(service.optShadertoyState.unwrap("no state"), gl)
                    const shaderLifecycle = lifecycle.own(new Terminator())
                    lifecycle.ownAll(
                        service.project.rootBox.shadertoy.catchupAndSubscribe(({targetVertex}) => {
                            shaderLifecycle.terminate()
                            targetVertex.match({
                                none: () => {
                                    gl.clearColor(0.0, 0.0, 0.0, 0.0)
                                    gl.clear(gl.COLOR_BUFFER_BIT)
                                    output.textContent = "No code"
                                    return Terminable.Empty
                                },
                                some: (box) => {
                                    const {shaderCode, highres} = asInstanceOf(box, ShadertoyBox)
                                    return shaderCode.catchupAndSubscribe(code => {
                                        shaderLifecycle.terminate()
                                        const {status, error} = tryCatch(() => runner.compile(code.getValue()))
                                        if (status === "failure") {
                                            output.textContent = String(error)
                                            return
                                        }
                                        output.textContent = "Running"
                                        shaderLifecycle.own(setupShadertoyRunner(runner, canvas, highres))
                                    })
                                }
                            })
                        }),
                        Events.subscribe(canvas, "click", async () => {
                            if (document.fullscreenElement) {
                                await document.exitFullscreen()
                            } else {
                                await canvas.requestFullscreen()
                            }
                        })
                    )
                }}/>
            </div>
            {output}
        </div>
    )
}