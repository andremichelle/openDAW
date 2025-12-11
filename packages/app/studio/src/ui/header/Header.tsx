import css from "./Header.sass?inline"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Lifecycle, Nullable, ObservableValue, Observer, panic, Subscription, Terminator} from "@opendaw/lib-std"
import {TransportGroup} from "@/ui/header/TransportGroup.tsx"
import {TimeStateDisplay} from "@/ui/header/TimeStateDisplay.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {createElement, Frag, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {MenuItem} from "@/ui/model/menu-item"
import {MidiDevices} from "@opendaw/studio-core"
import {Manual, Manuals} from "@/ui/pages/Manuals"
import {HorizontalPeakMeter} from "@/ui/components/HorizontalPeakMeter"
import {gainToDb} from "@opendaw/lib-dsp"
import {ContextMenu} from "@/ui/ContextMenu"
import {EngineAddresses} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "Header")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Header = ({lifecycle, service}: Construct) => {
    const peaksInDb = new Float32Array(2)
    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe((owner) => {
        runtime.terminate()
        owner.getValue().match<unknown>({
            none: () => peaksInDb.fill(Number.NEGATIVE_INFINITY),
            some: ({project: {liveStreamReceiver}}) =>
                runtime.own(liveStreamReceiver
                    .subscribeFloats(EngineAddresses.PEAKS, ([l, r]) => {
                        peaksInDb[0] = gainToDb(l)
                        peaksInDb[1] = gainToDb(r)
                    }))
        })
    }))
    const addManualMenuItems = (manuals: ReadonlyArray<Manual>): ReadonlyArray<MenuItem> => manuals.map(manual => {
        if (manual.type === "page") {
            return MenuItem.default({
                label: manual.label,
                checked: RouteLocation.get().path === manual.path
            }).setTriggerProcedure(() => RouteLocation.get().navigateTo(manual.path))
        } else if (manual.type === "folder") {
            return MenuItem.default({label: manual.label})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...addManualMenuItems(manual.files)))
        } else {
            return panic()
        }
    })
    return (
        <header className={className}>
            <MenuButton root={service.menu}
                        appearance={{color: Colors.gray, activeColor: Colors.bright, tinyTriangle: true}}>
                <h5>openDAW</h5>
            </MenuButton>
            <hr/>
            <div style={{display: "flex"}}>
                <Checkbox lifecycle={lifecycle}
                          model={MidiDevices.available()}
                          appearance={{activeColor: Colors.orange, tooltip: "Midi Access", cursor: "pointer"}}>
                    <Icon symbol={IconSymbol.Midi}/>
                </Checkbox>
                <MenuButton root={MenuItem.root()
                    .setRuntimeChildrenProcedure(parent =>
                        parent.addMenuItem(
                            MenuItem.header({label: "Manuals", icon: IconSymbol.OpenDAW, color: Colors.green}),
                            ...addManualMenuItems(Manuals)
                        ))} appearance={{color: Colors.green, tinyTriangle: true}}>
                    <Icon symbol={IconSymbol.Help}/>
                </MenuButton>
            </div>
            <hr/>
            <TransportGroup lifecycle={lifecycle} service={service}/>
            <hr/>
            <TimeStateDisplay lifecycle={lifecycle} service={service}/>
            {
                location.origin.includes("localhost") && (
                    <Frag>
                        <hr/>
                        <div title="Just a visual indicator to debug a smooth frame-rate"
                             style={{display: "flex", scale: "0.625"}}>
                            <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <g classList="spinner_GuJz">
                                    <circle cx="3" cy="12" r="2"/>
                                    <circle cx="21" cy="12" r="2"/>
                                    <circle cx="12" cy="21" r="2"/>
                                    <circle cx="12" cy="3" r="2"/>
                                    <circle cx="5.64" cy="5.64" r="2"/>
                                    <circle cx="18.36" cy="18.36" r="2"/>
                                    <circle cx="5.64" cy="18.36" r="2"/>
                                    <circle cx="18.36" cy="5.64" r="2"/>
                                </g>
                            </svg>
                        </div>
                    </Frag>
                )
            }
            <hr/>
            <Checkbox lifecycle={lifecycle}
                      onInit={element => lifecycle.own(ContextMenu.subscribe(element, collector =>
                          collector.addItems(MenuItem.default({label: "Set Count-In (Bars)"})
                              .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...[1, 2, 3, 4, 5, 6, 7, 8]
                                  .map(count => MenuItem.default({
                                      label: String(count),
                                      checked: count === service.engine.countInBarsTotal.getValue()
                                  }).setTriggerProcedure(() => service.engine.countInBarsTotal.setValue(count))))))))}
                      model={service.engine.metronomeEnabled}
                      appearance={{activeColor: Colors.orange, tooltip: "Metronome"}}>
                <Icon symbol={IconSymbol.Metronome}/>
            </Checkbox>
            <hr/>
            <div style={{flex: "1 0 0"}}/>
            {
                location.origin.includes("dev.opendaw.studio")
                && (<h5 style={{color: Colors.cream.toString()}}>DEV VERSION (UNSTABLE)</h5>)}
            <div style={{flex: "2 0 0"}}/>
            <hr/>
            <div className="header">
                <HorizontalPeakMeter lifecycle={lifecycle} peaksInDb={peaksInDb} width="4em"/>
            </div>
            <hr/>
            <div className="panel-selector">
                <RadioGroup lifecycle={lifecycle}
                            model={new class implements ObservableValue<Nullable<Workspace.ScreenKeys>> {
                                setValue(value: Nullable<Workspace.ScreenKeys>): void {
                                    if (service.hasProfile) {service.switchScreen(value)}
                                }
                                getValue(): Nullable<Workspace.ScreenKeys> {
                                    return service.layout.screen.getValue()
                                }
                                subscribe(observer: Observer<ObservableValue<Nullable<Workspace.ScreenKeys>>>): Subscription {
                                    return service.layout.screen.subscribe(observer)
                                }
                                catchupAndSubscribe(observer: Observer<ObservableValue<Nullable<Workspace.ScreenKeys>>>): Subscription {
                                    observer(this)
                                    return this.subscribe(observer)
                                }
                            }}
                            elements={Object.entries(Workspace.Default)
                                .filter(([_, {hidden}]: [string, Workspace.Screen]) => hidden !== true)
                                .map(([key, {icon: iconSymbol, name}]) => ({
                                    value: key,
                                    element: <Icon symbol={iconSymbol}/>,
                                    tooltip: name,
                                    className: name === "Modular"
                                        ? "experimental-section"
                                        : undefined
                                }))}
                            appearance={{framed: true, landscape: true}}/>
            </div>
        </header>
    )
}