import css from "./Footer.sass?inline"
import {createElement, Frag, LocalLink, replaceChildren} from "@moises-ai/lib-jsx"
import {isDefined, Lifecycle, Terminator, TimeSpan} from "@moises-ai/lib-std"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {AnimationFrame, Events, Html} from "@moises-ai/lib-dom"
import {Runtime} from "@moises-ai/lib-runtime"
import {FooterLabel} from "@/service/FooterLabel"
import {ProjectMeta, StudioPreferences} from "@moises-ai/studio-core"
import {Colors} from "@moises-ai/studio-enums"
import {UserCounter} from "@/UserCounter"
import {AudioData} from "@moises-ai/lib-dsp"
import {FooterItem} from "@/ui/FooterItem"

const className = Html.adoptStyleSheet(css, "footer")

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const Footer = ({lifecycle, service}: Construct) => {
    const {audioContext, buildInfo, engine, projectProfileService} = service
    return (
        <footer className={className}>
            <FooterItem title="Online" onInit={({value}) => {
                const updateOnline = () => value.textContent = navigator.onLine ? "Yes" : "No"
                lifecycle.ownAll(
                    Events.subscribe(window, "online", updateOnline),
                    Events.subscribe(window, "offline", updateOnline))
                updateOnline()
            }}/>
            <FooterItem className="name" title="Project"
                        onInit={({component, value}) => {
                            const profileLifecycle = lifecycle.own(new Terminator())
                            lifecycle.ownAll(
                                Events.subscribe(component, "dblclick", event => {
                                    const optProfile = projectProfileService.getValue()
                                    if (optProfile.isEmpty()) {return}
                                    const profile = optProfile.unwrap()
                                    const name = profile.meta.name
                                    if (isDefined(name)) {
                                        Surface.get(component).requestFloatingTextInput(event, name)
                                            .then(name => profile.updateMetaData("name", name))
                                    }
                                }),
                                projectProfileService.catchupAndSubscribe(optProfile => {
                                    profileLifecycle.terminate()
                                    if (optProfile.nonEmpty()) {
                                        const profile = optProfile.unwrap()
                                        const observer = (meta: ProjectMeta) => value.textContent = meta.name
                                        profileLifecycle.own(profile.subscribeMetaData(observer))
                                        observer(profile.meta)
                                    } else {
                                        value.textContent = "⏏︎"
                                    }
                                }))
                        }}/>
            <FooterItem title="SampleRate">{audioContext.sampleRate}</FooterItem>
            <FooterItem title="Latency" minWidth="6ch"
                        onInit={({value}) => {
                            lifecycle.own(Runtime.scheduleInterval(() => {
                                const outputLatency = audioContext.outputLatency
                                if (outputLatency > 0.0) {
                                    value.textContent = `${(outputLatency * 1000.0).toFixed(1)}ms`
                                }
                            }, 1000))
                        }}>N/A</FooterItem>
            <FooterItem title="CPU Load" minWidth="4ch"
                        onInit={({component, value}) => {
                            lifecycle.own(engine.preferences.catchupAndSubscribe(enabled => {
                                component.classList.toggle("hidden", !enabled)
                            }, "debug", "dspLoadMeasurement"))
                            lifecycle.own(engine.cpuLoad.catchupAndSubscribe(owner => {
                                const percent = Math.min(owner.getValue(), 100)
                                value.textContent = `${percent}%`
                                value.style.color = percent >= 100 ? Colors.red.toString()
                                    : percent > 75 ? Colors.orange.toString() : ""
                            }))
                        }}>0%</FooterItem>
            <FooterItem title="FPS"
                        onInit={({component, value}) => {
                            const lifeSpan = lifecycle.own(new Terminator())
                            lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                                component.classList.toggle("hidden", !show)
                                if (show) {
                                    let frame = 0 | 0
                                    let lastTime = Date.now()
                                    lifeSpan.own(AnimationFrame.add(() => {
                                        if (Date.now() - lastTime >= 1000) {
                                            value.textContent = String(frame)
                                            lastTime = Date.now()
                                            frame = 0
                                        } else {frame++}
                                    }))
                                } else {
                                    lifeSpan.terminate()
                                }
                            }, "debug", "footer-show-fps-meter"))
                        }}>0</FooterItem>
            <FooterItem title="Samples (GC)"
                        onInit={({component, value}) => {
                            const lifeSpan = lifecycle.own(new Terminator())
                            lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                                component.classList.toggle("hidden", !show)
                                if (show) {
                                    lifeSpan.own(Runtime.scheduleInterval(() => {
                                        value.textContent = AudioData.count().toString()
                                    }, 1000))
                                } else {
                                    lifeSpan.terminate()
                                }
                            }, "debug", "footer-show-samples-memory"))
                        }}>0</FooterItem>
            <div style={{display: "contents"}}
                 onInit={element => {
                     const lifeSpan = lifecycle.own(new Terminator())
                     lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                         element.classList.toggle("hidden", !show)
                         if (show) {
                             replaceChildren(element, (
                                 <Frag>
                                     <FooterItem title="Build Version">{buildInfo.uuid}</FooterItem>
                                     <FooterItem title="Build Time"
                                                 onInit={({value}) => {
                                                     const buildDateMillis = new Date(buildInfo.date).getTime()
                                                     const update = () => value.textContent =
                                                         TimeSpan.millis(buildDateMillis - new Date().getTime()).toUnitString()
                                                     lifeSpan.own(Runtime.scheduleInterval(update, 1000))
                                                     update()
                                                 }}/>
                                 </Frag>
                             ))
                         } else {
                             replaceChildren(element)
                             lifeSpan.terminate()
                         }
                     }, "debug", "footer-show-build-infos"))
                 }}/>
            <FooterItem title="Users"
                        onInit={({value}) => {
                            const counter = new UserCounter("https://api.opendaw.studio/users/user-counter.php")
                            counter.subscribe(count => value.textContent = String(count))
                        }}>#</FooterItem>
            <div style={{display: "contents"}}
                 onInit={element => service.registerFooter((): FooterLabel => {
                     let titleRef!: HTMLElement
                     let valueRef!: HTMLElement
                     const item: HTMLElement = <FooterItem title="" onInit={({title, value}) => {
                         titleRef = title
                         valueRef = value
                     }}/>
                     element.appendChild(item)
                     return {
                         setTitle: (text: string) => titleRef.textContent = text,
                         setValue: (text: string) => valueRef.textContent = text,
                         terminate: () => {if (item.isConnected) {item.remove()}}
                     } satisfies FooterLabel
                 })}/>
            <div style={{flex: "1"}}/>
            <div style={{color: Colors.cream.toString()}}>
                <LocalLink href="/privacy">Privacy</LocalLink> · <LocalLink href="/imprint">Imprint</LocalLink>
            </div>
        </footer>
    )
}