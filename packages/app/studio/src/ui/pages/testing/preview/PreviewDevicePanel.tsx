import panelCss from "@/ui/devices/panel/DevicePanel.sass?inline"
import editorCss from "@/ui/devices/DeviceEditor.sass?inline"
import meterCss from "@/ui/devices/panel/DevicePeakMeter.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {DeviceType} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {getColorFor} from "@/ui/devices/DeviceEditor"

const panelClassName = Html.adoptStyleSheet(panelCss, "DevicePanel")
const editorClassName = Html.adoptStyleSheet(editorCss, "DeviceEditor")
const meterClassName = Html.adoptStyleSheet(meterCss, "DevicePeakMeter")

// the studio's device panel and device frame around unreleased editors, without a project behind them
export namespace PreviewDevicePanel {
    export type Editor = {
        readonly lifecycle: Lifecycle
        readonly name: string
        readonly icon: IconSymbol
        readonly type: DeviceType
        readonly controls: JsxValue
    }

    const containerClass = (type: DeviceType): string =>
        type === "midi-effect" ? "midi-container" : type === "audio-effect" ? "audio-container" : "source-container"

    export const editor = ({lifecycle, name, icon, type, controls}: Editor): HTMLElement => {
        const color = getColorFor(type)
        const element: HTMLElement = <div className={Html.buildClassList(editorClassName, "enabled")}/>
        const body: HTMLElement = <div>{controls}</div>
        const header: HTMLElement = (
            <header style={{color: color.toString()}}>
                <Icon symbol={icon} onInit={glyph => lifecycle.own(Events.subscribe(glyph, "click", () => {
                    element.classList.toggle("minimized")
                    body.classList.toggle("hidden", element.classList.contains("minimized"))
                }))}/>
                <Icon symbol={IconSymbol.Shutdown} onInit={glyph => lifecycle.own(Events.subscribe(glyph, "click", () =>
                    element.classList.toggle("enabled")))}/>
                <h1>{name}</h1>
                <MenuButton root={MenuItem.root()} appearance={{tooltip: "Load preset"}}
                            style={{fontSize: "14px", color: "currentColor"}}>
                    <Icon symbol={IconSymbol.Folder}/>
                </MenuButton>
            </header>
        )
        element.append(
            header,
            <MenuButton root={MenuItem.root()} style={{minWidth: "0", fontSize: "0.75em"}}
                        appearance={{color, activeColor: Colors.bright}}>
                <Icon symbol={IconSymbol.Menu}/>
            </MenuButton>,
            body,
            <div className={meterClassName}/>,
            <div/>
        )
        return (
            <div className={containerClass(type)}>{element}</div>
        )
    }

    export const create = (editors: ReadonlyArray<HTMLElement>): HTMLElement => (
        <div className={panelClassName}>
            <div className="devices">
                <div className="editors">
                    <div className="containers">{editors}</div>
                </div>
            </div>
        </div>
    )
}
