import css from "./ChatOverlay.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {Icon} from "@/ui/components/Icon.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {ChatOverlayBackground} from "@/ui/ChatOverlayBackground.tsx"

const className = Html.adoptStyleSheet(css, "ChatOverlay")

type DummyMessage = {
    name: string
    color: string
    text: string
    time: string
    self: boolean
}

const dummyMessages: ReadonlyArray<DummyMessage> = [
    {name: "Alice", color: "#E06C75", text: "Hey, anyone here?", time: "14:02", self: false},
    {name: "You", color: "#61AFEF", text: "Yeah, just joined!", time: "14:03", self: true},
    {name: "Alice", color: "#E06C75", text: "Cool! I added a new synth track, check it out", time: "14:03", self: false},
    {name: "Bob", color: "#98C379", text: "Sounds great, but the reverb is a bit much", time: "14:05", self: false},
    {name: "You", color: "#61AFEF", text: "Agreed, I will dial it back", time: "14:05", self: true},
    {name: "Alice", color: "#E06C75", text: "Can you also try a shorter decay on the delay?", time: "14:06", self: false},
    {name: "Bob", color: "#98C379", text: "I am working on the drum pattern btw", time: "14:07", self: false},
    {name: "You", color: "#61AFEF", text: "Nice, let me know when it is ready", time: "14:07", self: true},
    {name: "Alice", color: "#E06C75", text: "I have been thinking about the arrangement and I feel like we need a longer intro section with some atmospheric pads building up slowly before the main beat drops in. Maybe we could also add some field recordings or foley sounds to give it more texture and depth. What do you think about layering some vinyl crackle underneath?", time: "14:10", self: false},
    {name: "Bob", color: "#98C379", text: "That sounds like a solid plan. I could also pitch-shift some of the vocal chops and scatter them across the stereo field to create a wider soundstage. We should also consider adding a breakdown section around the two minute mark where everything strips back to just the bass and some filtered percussion before building back up", time: "14:12", self: false},
    {name: "You", color: "#61AFEF", text: "Love both ideas. Let me bounce the current mix so we have a reference point before making changes. I will also export the stems separately so we can each work on our parts independently and merge them later without stepping on each other", time: "14:13", self: true}
]

type Construct = { lifecycle: Lifecycle }

export const ChatOverlay = ({lifecycle}: Construct) => {
    const sendOnEnter = lifecycle.own(new DefaultObservableValue<boolean>(true))
    const closeAfterSend = lifecycle.own(new DefaultObservableValue<boolean>(true))
    const element: HTMLElement = (
        <div className={className}>
            <div className="chat-tab" onInit={(tab: HTMLElement) => {
                lifecycle.own(Events.subscribe(tab, "click", () => {
                    element.classList.toggle("open")
                }))
            }}>
                <Icon symbol={IconSymbol.ChatEmpty}/>
            </div>
            <div className="chat-window">
                <div className="messages">
                    {dummyMessages.map(message => (
                        <div className={message.self ? "message self" : "message"}>
                            <div className="header">
                                <span className="dot" style={{backgroundColor: message.color}}/>
                                <span className="name">{message.name}</span>
                                <span className="time">{message.time}</span>
                            </div>
                            <div className="text" style={{borderLeftColor: message.color}}>{message.text}</div>
                        </div>
                    ))}
                </div>
                <div className="input-area">
                    <input type="text" placeholder="Type a message..." maxLength={300}/>
                    <button className="send">
                        <Icon symbol={IconSymbol.Play}/>
                    </button>
                </div>
                <div className="options">
                    <Checkbox lifecycle={lifecycle} model={sendOnEnter}>
                        <Icon symbol={IconSymbol.Checkbox}/> Send on Enter
                    </Checkbox>
                    <Checkbox lifecycle={lifecycle} model={closeAfterSend}>
                        <Icon symbol={IconSymbol.Checkbox}/> Close after send
                    </Checkbox>
                </div>
            </div>
        </div>
    )
    element.prepend(<ChatOverlayBackground lifecycle={lifecycle} element={element}/>)
    return element
}
