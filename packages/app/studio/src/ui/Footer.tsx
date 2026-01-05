import css from "./Footer.sass?inline"
import {createElement, Frag, LocalLink, replaceChildren} from "@opendaw/lib-jsx"
import {isDefined, Lifecycle, Terminator, TimeSpan} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {FooterLabel} from "@/service/FooterLabel"
import {ProjectMeta, StudioPreferences} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {UserCounter} from "@/UserCounter"
import {AudioData} from "@opendaw/lib-dsp"

const className = Html.adoptStyleSheet(css, "footer")

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const Footer = ({lifecycle, service}: Construct) => {
    return (
        <footer className={className}>
            <article title="Online" onInit={element => {
                const updateOnline = () => element.textContent = navigator.onLine ? "Yes" : "No"
                lifecycle.ownAll(
                    Events.subscribe(window, "online", updateOnline),
                    Events.subscribe(window, "offline", updateOnline))
                updateOnline()
            }}/>
            <article className="name"
                     title="Project"
                     onInit={element => {
                         const profileLifecycle = lifecycle.own(new Terminator())
                         lifecycle.ownAll(
                             Events.subscribe(element, "dblclick", event => {
                                 const optProfile = service.projectProfileService.getValue()
                                 if (optProfile.isEmpty()) {return}
                                 const profile = optProfile.unwrap()
                                 const name = profile.meta.name
                                 if (isDefined(name)) {
                                     Surface.get(element).requestFloatingTextInput(event, name)
                                         .then(name => profile.updateMetaData("name", name))
                                 }
                             }),
                             service.projectProfileService.catchupAndSubscribe(optProfile => {
                                 profileLifecycle.terminate()
                                 if (optProfile.nonEmpty()) {
                                     const profile = optProfile.unwrap()
                                     const observer = (meta: ProjectMeta) => element.textContent = meta.name
                                     profileLifecycle.own(profile.subscribeMetaData(observer))
                                     observer(profile.meta)
                                 } else {
                                     element.textContent = "⏏︎"
                                 }
                             }))
                     }}/>
            <article title="SampleRate">{service.audioContext.sampleRate}</article>
            <article title="Latency"
                     onInit={element => {
                         lifecycle.own(Runtime.scheduleInterval(() => {
                             const outputLatency = service.audioContext.outputLatency
                             if (outputLatency > 0.0) {
                                 element.textContent = `${(outputLatency * 1000.0).toFixed(1)}ms`
                             }
                         }, 1000))
                     }}>N/A
            </article>
            <article title="FPS"
                     onInit={element => {
                         const lifeSpan = lifecycle.own(new Terminator())
                         lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                             element.classList.toggle("hidden", !show)
                             if (show) {
                                 let frame = 0 | 0
                                 let lastTime = Date.now()
                                 lifeSpan.own(AnimationFrame.add(() => {
                                     if (Date.now() - lastTime >= 1000) {
                                         element.textContent = String(frame)
                                         lastTime = Date.now()
                                         frame = 0
                                     } else {frame++}
                                 }))
                             } else {
                                 lifeSpan.terminate()
                             }
                         }, "footer-show-fps-meter"))
                     }}>0
            </article>
            <article title="Samples"
                     onInit={element => {
                         const lifeSpan = lifecycle.own(new Terminator())
                         lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                             element.classList.toggle("hidden", !show)
                             if (show) {
                                 lifeSpan.own(Runtime.scheduleInterval(() => {
                                     element.textContent = AudioData.count().toString()
                                 }, 1000))
                             } else {
                                 lifeSpan.terminate()
                             }
                         }, "footer-show-samples-memory"))
                     }}>0
            </article>
            <div style={{display: "contents"}}
                 onInit={element => {
                     const lifeSpan = lifecycle.own(new Terminator())
                     lifecycle.own(StudioPreferences.catchupAndSubscribe(show => {
                         element.classList.toggle("hidden", !show)
                         if (show) {
                             replaceChildren(element, (
                                 <Frag>
                                     <article title="Build Version">{service.buildInfo.uuid}</article>
                                     <article title="Build Time" onInit={element => {
                                         const buildDateMillis = new Date(service.buildInfo.date).getTime()
                                         const update = () => element.textContent =
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
                     }, "footer-show-build-infos"))
                 }}/>
            <article title="Users"
                     onInit={async element => {
                         const counter = new UserCounter("https://api.opendaw.studio/users/user-counter.php")
                         element.textContent = String(await counter.start())
                         setInterval(async () => element.textContent = String(await counter.updateUserCount()), 30000)
                         window.addEventListener("beforeunload", () => counter.stop())
                     }}>#
            </article>
            <div style={{display: "contents"}}
                 onInit={element => service.registerFooter((): FooterLabel => {
                     const label: HTMLElement = <article/>
                     element.appendChild(label)
                     return {
                         setTitle: (value: string) => label.title = value,
                         setValue: (value: string) => label.textContent = value,
                         terminate: () => {if (label.isConnected) {label.remove()}}
                     } satisfies FooterLabel
                 })}/>
            <div style={{flex: "1"}}/>
            <div style={{color: Colors.cream.toString()}}>
                <LocalLink href="/privacy">Privacy</LocalLink> · <LocalLink href="/imprint">Imprint</LocalLink>
            </div>
        </footer>
    )
}