import css from "./DemoProjects.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement, HTML} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "DemoProjects")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const DemoProjects = ({service}: Construct) => {
    return (
        <div className={className}>
            <h3 style={{color: Colors.orange.toString()}}>Demo Projects</h3>
            <div className="starters">
                {[
                    {name: "New", click: () => service.newProject()},
                    {name: "Sunset", click: () => service.loadTemplate("Sunset")},
                    {name: "Breeze", click: () => service.loadTemplate("Breeze")},
                    {name: "Shafted", click: () => service.loadTemplate("Shafted")},
                    {name: "Seek Deeper", click: () => service.loadTemplate("SeekDeeper")},
                    {name: "Fatso", click: () => service.loadTemplate("Fatso")},
                    {name: "Bury Me", click: () => service.loadTemplate("BuryMe")},
                    {
                        name: "Bury Me (BMX Remix)",
                        click: () => service.loadTemplate("BMX_Skyence_buryme_Remix")
                    },
                    {name: "Ben", click: () => service.loadTemplate("Ben")},
                    {name: "Liquid", click: () => service.loadTemplate("BMX_LiquidDrums")},
                    {name: "Release", click: () => service.loadTemplate("Release")},
                    {name: "Dub Techno", click: () => service.loadTemplate("Dub-Techno")}
                ].map(({name, click}, index) => {
                    const svgSource = `viscious-speed/${String(index + 1)
                        .padStart(2, "0")}.svg`
                    return (
                        <div onclick={click}>
                            <HTML src={fetch(svgSource)} className="icon"/>
                            <label>{name}</label>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}