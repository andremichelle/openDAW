import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {RailSection} from "@/ui/dashboard/RailSection"

type Link = { label: string, href: string, icon: IconSymbol }

const links: ReadonlyArray<Link> = [
    {label: "opendaw.org", href: "https://opendaw.org", icon: IconSymbol.OpenDAW},
    {label: "GitHub", href: "https://github.com/andremichelle/openDAW", icon: IconSymbol.Github},
    {label: "Discord", href: "https://discord.opendaw.studio/", icon: IconSymbol.Discord},
    {label: "Instagram", href: "https://www.instagram.com/opendaw.studio", icon: IconSymbol.Instagram},
    {label: "LinkedIn", href: "https://www.linkedin.com/company/opendaw-org", icon: IconSymbol.LinkedIn}
]

export const Links = () => (
    <RailSection title="Links" vertical={true}>
        {links.map(({label, href, icon}) => (
            <a className="link" href={href} target="_blank" rel="noopener noreferrer">
                <Icon symbol={icon}/><span>{label}</span>
            </a>
        ))}
    </RailSection>
)
