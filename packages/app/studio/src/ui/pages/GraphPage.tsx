import css from "./GraphPage.sass?inline"
import {Await, createElement, DomElement, Frag, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import type {StudioService} from "@/service/StudioService.ts"
import {GraphData} from "./graph-runtime"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {UUID} from "@moises-ai/lib-std"
import {Colors} from "@moises-ai/studio-enums"
import {RootBox} from "@moises-ai/studio-boxes"

const className = Html.adoptStyleSheet(css, "GraphPage")

export const GraphPage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const element: DomElement = (
        <div className={className}>
            {service.projectProfileService.getValue().match({
                none: () => (
                    <Frag>
                        <h1>Graph</h1>
                        <p onclick={() => service.closeProject()}
                           style={{color: Colors.dark.toString(), cursor: "pointer"}}>Open a project first...</p>
                    </Frag>
                ),
                some: ({project, meta}) => (
                    <Await factory={() => import("./graph-runtime")}
                           failure={({reason}) => (<p>{reason}</p>)}
                           loading={() => (<ThreeDots/>)}
                           success={({createGraphPanel, GRAPH_INTERACTION_HINT}) => {
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
                               const container = (<div className="wrapper"/>)
                               const controller = createGraphPanel(container, data, {dark: true})
                               lifecycle.own(controller)
                               lifecycle.own(Html.watchResize(element, () => controller.resize()))
                               return (
                                   <Frag>
                                       <h1>Graph '{meta.name}'</h1>
                                       <p style={{
                                           fontSize: "0.75em",
                                           color: Colors.dark.toString()
                                       }}>{GRAPH_INTERACTION_HINT}</p>
                                       {container}
                                   </Frag>
                               )
                           }}/>
                )
            })}
        </div>
    )
    return element
}