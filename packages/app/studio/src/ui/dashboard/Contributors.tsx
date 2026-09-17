import {Await, createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {RailSection} from "@/ui/dashboard/RailSection"
import {RailFooterLink} from "@/ui/dashboard/RailFooterLink"
import {Contributor, fetchContributors} from "@/ui/pages/stats/data"

export const Contributors = () => (
    <RailSection title={[<span>Contributors</span>, <Icon symbol={IconSymbol.Github}/>]}>
        <Await factory={() => fetchContributors()}
               loading={() => null}
               failure={() => null}
               success={(contributors: ReadonlyArray<Contributor>) => contributors.length === 0 ? null : (
                   <div className="sponsors">
                       {contributors.map(contributor => (
                           <a href={contributor.url} target="_blank" rel="noopener noreferrer"
                              title={`${contributor.login} · ${contributor.contributions} commits`}>
                               <img src={contributor.avatarUrl} alt={contributor.login} loading="lazy"
                                    crossOrigin="anonymous"/>
                           </a>
                       ))}
                   </div>
               )}/>
        <RailFooterLink href="https://github.com/andremichelle/openDAW/graphs/contributors">Thank you ♡</RailFooterLink>
    </RailSection>
)
