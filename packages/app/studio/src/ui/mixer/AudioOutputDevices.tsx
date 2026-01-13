import css from "./AudioOutputDevices.sass?inline"
import {Procedure} from "@moises-ai/lib-std"
import {Await, createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {AudioOutputDevice} from "@/audio/AudioOutputDevice"
import {AudioDevices} from "@/audio/AudioDevices"

const className = Html.adoptStyleSheet(css, "AudioOutputDevices")

type Construct = {
    output: AudioOutputDevice
    provider: Procedure<MediaDeviceInfo>
}

export const AudioOutputDevices = ({output, provider}: Construct) => {
    return (
        <div className={className} style={{padding: "1em 0"}}>
            <Await factory={() => AudioDevices.queryListOutputDevices()}
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
                           .then(output => list.querySelector(`div[deviceId="${output.deviceId}"]`)
                               ?.classList.add("active"), reason => console.debug(reason))
                       return list
                   }}
            />
        </div>
    )
}