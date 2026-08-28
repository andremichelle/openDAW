import {createElement} from "@opendaw/lib-jsx"
import {RailSection} from "@/ui/dashboard/RailSection"
import {FlexSpacer} from "@/ui/components/FlexSpacer"

type Provider = { name: string, href: string, logo: string }

const providers: ReadonlyArray<Provider> = [
    {name: "ModeAudio", href: "https://modeaudio.com/", logo: "/images/modeaudio.webp"}
]

export const SampleProviders = () => (
    <RailSection title="Samples" vertical={true}>
        <FlexSpacer pixels={0}/>
        {providers.map(({name, href, logo}) => (
            <a className="provider" href={href} target="_blank" rel="noopener noreferrer" title={name}>
                <img src={logo} alt={name} loading="lazy"/>
            </a>
        ))}
    </RailSection>
)
