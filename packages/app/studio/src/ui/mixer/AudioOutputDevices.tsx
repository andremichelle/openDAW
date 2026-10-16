import css from "./AudioOutputDevices.sass?inline"
import {Procedure} from "@opendaw/lib-std"
import {Await, createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioOutputDevice, OutputDevice} from "@/audio/AudioOutputDevice"

const className = Html.adoptStyleSheet(css, "AudioOutputDevices")

type Construct = {
    output: AudioOutputDevice
    provider: Procedure<OutputDevice>
}

export const AudioOutputDevices = ({output, provider}: Construct) => {
    return (
        <div className={className} style={{padding: "1em 0"}}>
            <Await factory={() => output.listDevices()}
                   loading={() => (
                       <div>Please allow access to list audio-devices...</div>
                   )}
                   failure={({reason, retry}) => (
                       <div className="failure"
                            onclick={async () => {
                                console.warn(reason)
                                retry()
                            }}>Check permissions and <span style={{textDecoration: "underline"}}>retry.</span>
                       </div>
                   )}
                   success={devices => {
                       const list: HTMLElement = (
                           <div className="devices">
                               {devices.map(device => (
                                   <div onclick={() => provider(device)} deviceId={device.deviceId}>
                                       {device.label}
                                   </div>
                               ))}
                           </div>
                       )
                       output.resolveOutput()
                           .then(output => list.querySelector(`div[deviceId="${CSS.escape(output.deviceId)}"]`)
                               ?.classList.add("active"), reason => console.debug(reason))
                       return list
                   }}
            />

        </div>
    )
}