import {isDefined} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {RailSection} from "@/ui/dashboard/RailSection"

// `iconScale` optically balances a single mark against the others WITHOUT touching the shared sprite: the
// openDAW glyph fills 91.7% of its 24x24 viewBox (ink runs 1..23) while the brand marks beside it carry their
// own padding (GitHub/Instagram sit at 83.3%), so at RailSection's shared 16px it reads noticeably heavier.
// IconSymbol.OpenDAW is used by the header, spotlight and menus too, so the fix belongs here, not in
// IconLibrary. `scale` shrinks the ink but keeps the 16px box, so every label stays in one column.
type Link = { label: string, href: string, icon: IconSymbol, iconScale?: number }

const links: ReadonlyArray<Link> = [
    {label: "opendaw.org", href: "https://opendaw.org", icon: IconSymbol.OpenDAW, iconScale: 0.9},
    {label: "GitHub", href: "https://github.com/andremichelle/openDAW", icon: IconSymbol.Github},
    {label: "Discord", href: "https://discord.opendaw.studio/", icon: IconSymbol.Discord},
    {label: "Instagram", href: "https://www.instagram.com/opendaw.studio", icon: IconSymbol.Instagram},
    {label: "LinkedIn", href: "https://www.linkedin.com/company/opendaw-org", icon: IconSymbol.LinkedIn},
    {label: "Newsletter", href: "https://buttondown.com/opendaw", icon: IconSymbol.Notification}
]

export const Links = () => (
    <RailSection title="Links" vertical={true}>
        {links.map(({label, href, icon, iconScale}) => (
            <a className="link" href={href} target="_blank" rel="noopener noreferrer">
                <Icon symbol={icon} style={isDefined(iconScale) ? {scale: String(iconScale)} : undefined}/>
                <span>{label}</span>
            </a>
        ))}
    </RailSection>
)
