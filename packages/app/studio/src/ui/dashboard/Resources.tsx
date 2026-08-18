import css from "./Resources.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {ProjectBrowser} from "@/project/ProjectBrowser"
import {TemplateBrowser} from "@/project/TemplateBrowser"
import {Dialogs} from "@/ui/components/dialogs"
import {SampleBrowser} from "@/ui/browse/SampleBrowser"
import {SoundfontBrowser} from "@/ui/browse/SoundfontBrowser"
import {StudioService} from "@/service/StudioService"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Colors} from "@opendaw/studio-enums"
import {DemoProjectsList} from "@/ui/dashboard/DemoProjectsList"

const className = Html.adoptStyleSheet(css, "Resources")

const enum Scope { Projects, Templates, Demos, Samples, Soundfonts }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Resources = ({lifecycle, service}: Construct) => {
    const scope = new DefaultObservableValue<Scope>(Scope.Projects)
    return (
        <div className={className}>
            <RadioGroup lifecycle={lifecycle}
                        style={{columnGap: "1em"}}
                        appearance={{activeColor: Colors.orange}}
                        model={scope}
                        elements={[
                            {value: Scope.Projects, element: (<h3>Projects</h3>)},
                            {value: Scope.Templates, element: (<h3>Templates</h3>)},
                            {value: Scope.Demos, element: (<h3>Demos</h3>)},
                            {value: Scope.Samples, element: (<h3>Samples</h3>)},
                            {value: Scope.Soundfonts, element: (<h3>Soundfonts</h3>)}
                        ]}/>
            <div className="content" onInit={element => {
                const scopeLifeCycle = lifecycle.own(new Terminator())
                lifecycle.own(scope.catchupAndSubscribe(owner => {
                    replaceChildren(element)
                    scopeLifeCycle.terminate()
                    switch (owner.getValue()) {
                        case Scope.Projects:
                            replaceChildren(element, (
                                <ProjectBrowser service={service}
                                                lifecycle={scopeLifeCycle}
                                                select={async ([uuid, meta]) => {
                                                    const handler = Dialogs.processMonolog("Loading...")
                                                    const {status, error} = await Promises.tryCatch(
                                                        service.projectProfileService.load(uuid, meta))
                                                    handler.close()
                                                    if (status === "rejected") {
                                                        console.warn(error)
                                                        RuntimeNotifier.notify({
                                                            message: "Could not load project.", icon: "Warning"
                                                        })
                                                    }
                                                }}
                                                empty={<div className="empty-cta"
                                                            onclick={() => scope.setValue(Scope.Demos)}>
                                                    No projects yet. Start with a demo project.
                                                </div>}/>
                            ))
                            break
                        case Scope.Templates:
                            replaceChildren(element, (
                                <TemplateBrowser service={service}
                                                 lifecycle={scopeLifeCycle}
                                                 select={async ([uuid, meta]) => {
                                                     const handler = Dialogs.processMonolog("Loading...")
                                                     const {status, error} = await Promises.tryCatch(
                                                         service.projectProfileService.openTemplate(uuid, meta))
                                                     handler.close()
                                                     if (status === "rejected") {
                                                         console.warn(error)
                                                         RuntimeNotifier.notify({
                                                             message: "Could not open template.", icon: "Warning"
                                                         })
                                                     }
                                                 }}/>
                            ))
                            break
                        case Scope.Demos:
                            replaceChildren(element, (
                                <DemoProjectsList lifecycle={scopeLifeCycle} service={service}/>
                            ))
                            break
                        case Scope.Samples:
                            replaceChildren(element, (
                                <SampleBrowser lifecycle={scopeLifeCycle} service={service}/>
                            ))
                            break
                        case Scope.Soundfonts:
                            replaceChildren(element, (
                                <SoundfontBrowser lifecycle={scopeLifeCycle} service={service}/>
                            ))
                            break
                    }
                }))
            }}>
            </div>
        </div>
    )
}
