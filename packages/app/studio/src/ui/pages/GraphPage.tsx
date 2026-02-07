import css from "./GraphPage.sass?inline"
import { Await, createElement, DomElement, Frag, PageContext, PageFactory } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"
import type { StudioService } from "@/service/StudioService.ts"
import { GraphData } from "./graph-runtime"
import { ThreeDots } from "@/ui/spinner/ThreeDots"
import { UUID } from "@opendaw/lib-std"
import { Colors } from "@opendaw/studio-enums"
import { RootBox } from "@opendaw/studio-boxes"

const className = Html.adoptStyleSheet(css, "GraphPage")

export const GraphPage: PageFactory<StudioService> = ({ lifecycle, service }: PageContext<StudioService>) => {
    const title = service.projectProfileService.getValue().match({
        none: () => "Graph",
        some: ({ meta }) => `Graph '${meta.name}'`
    })

    const element: DomElement = (
        <div className={className}>
            <h1>{title}</h1>
            {service.projectProfileService.getValue().match({
                none: () => (
                    <p onclick={() => service.closeProject()}
                        style={{ color: Colors.dark.toString(), cursor: "pointer" }}>Open a project first...</p>
                ),
                some: ({ project }) => (
                    <Await factory={() => import("./graph-runtime")}
                        failure={({ reason }) => (<p>{reason}</p>)}
                        loading={() => (<ThreeDots />)}
                        success={({ createGraphPanel, GRAPH_INTERACTION_HINT }) => {
                            const stripBoxSuffix = (label?: string) =>
                                label?.endsWith("Box")
                                    ? label.slice(0, -3)
                                    : label
                            const boxes = project.boxGraph.boxes()
                            const data: GraphData = {
                                nodes: boxes.map(box => ({
                                    id: UUID.toString(box.address.uuid),
                                    label: stripBoxSuffix(box.name),
                                    root: box instanceof RootBox
                                })),
                                edges: boxes.flatMap(box => box.outgoingEdges().map(([pointer, address]) => ({
                                    source: UUID.toString(pointer.box.address.uuid),
                                    target: UUID.toString(address.uuid)
                                })))
                            }
                            const container = (<div className="wrapper" />)
                            const controller = createGraphPanel(container, data, { dark: true })
                            lifecycle.own(controller)
                            lifecycle.own(Html.watchResize(element, () => controller.resize()))
                            return (
                                <Frag>
                                    <p style={{
                                        fontSize: "0.75em",
                                        color: Colors.dark.toString()
                                    }}>{GRAPH_INTERACTION_HINT}</p>
                                    {container}
                                </Frag>
                            )
                        }} />
                )
            })}
        </div>
    )
    return element
}