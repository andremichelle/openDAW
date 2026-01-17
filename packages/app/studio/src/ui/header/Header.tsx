import css from "./Header.sass?inline"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Lifecycle, Nullable, ObservableValue, Observer, panic, Subscription, Terminator} from "@opendaw/lib-std"
import {TransportGroup} from "@/ui/header/TransportGroup.tsx"
import {TimeStateDisplay} from "@/ui/header/TimeStateDisplay.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {createElement, Group, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {MenuItem, MidiDevices, StudioPreferences} from "@opendaw/studio-core"
import {Manual, Manuals} from "@/ui/pages/Manuals"
import {HorizontalPeakMeter} from "@/ui/components/HorizontalPeakMeter"
import {gainToDb} from "@opendaw/lib-dsp"
import {EngineAddresses} from "@opendaw/studio-adapters"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {ShortcutTooltip} from "@/ui/shortcuts/ShortcutTooltip"
import {UndoRedoButtons} from "@/ui/header/UndoRedoButtons"
import {MetronomeControl} from "@/ui/header/MetronomeControl"

const className = Html.adoptStyleSheet(css, "Header")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const ScreenShortcutKeys: Record<Workspace.ScreenKeys, keyof typeof GlobalShortcuts> = {
    "dashboard": "workspace-screen-dashboard",
    "default": "workspace-screen-default",
    "mixer": "workspace-screen-mixer",
    "piano": "workspace-screen-piano",
    "project": "workspace-screen-project",
    "shadertoy": "workspace-screen-shadertoy",
    "meter": "workspace-screen-meter"
}

export const Header = ({lifecycle, service}: Construct) => {
    const peaksInDb = new Float32Array(2)
    const runtime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe((optProfile) => {
        runtime.terminate()
        optProfile.match<unknown>({
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
                icon: manual.icon,
                checked: RouteLocation.get().path === manual.path,
                separatorBefore: manual.separatorBefore ?? false
            }).setTriggerProcedure(() => RouteLocation.get().navigateTo(manual.path))
        } else if (manual.type === "folder") {
            return MenuItem.default({
                label: manual.label,
                icon: manual.icon,
                separatorBefore: manual.separatorBefore ?? false
            }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(...addManualMenuItems(manual.files)))
        } else {
            return panic()
        }
    })
    const {preferences} = service.engine
    return (
        <header className={className}>
            <MenuButton root={service.menu}
                        appearance={{color: Colors.gray, activeColor: Colors.bright, tinyTriangle: true}}>
                <h5>openDAW</h5>
            </MenuButton>
            <hr/>
            <Group onInit={element => StudioPreferences.catchupAndSubscribe(enabled =>
                element.classList.toggle("hidden", !enabled), "visibility", "enable-history-buttons")}>
                <UndoRedoButtons lifecycle={lifecycle} service={service}/>
                <hr/>
            </Group>
            <div style={{display: "flex", columnGap: "4px"}}>
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
            <hr/>
            <MetronomeControl lifecycle={lifecycle}
                              service={service}
                              preferences={preferences}/>
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
                                    tooltip: ShortcutTooltip.create(name,
                                        GlobalShortcuts[ScreenShortcutKeys[key as Workspace.ScreenKeys]].shortcut)
                                }))}
                            appearance={{framed: true, landscape: true}}/>
            </div>
        </header>
    )
}