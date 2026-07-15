import {Await, createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {RailSection} from "@/ui/dashboard/RailSection"
import {fetchSponsorStats, SponsorStats} from "@/ui/pages/stats/data"

// Up to 20 sponsor avatars, reusing the /stats sponsor feed. No "+N more" cap (see plans/welcome-dashboard.md).
export const Sponsors = () => (
    <RailSection title={[<span>Sponsors</span>, <Icon symbol={IconSymbol.Heart}/>]}>
        <Await factory={() => fetchSponsorStats()}
               loading={() => null}
               failure={() => null}
               success={(stats: SponsorStats) => stats.totalCount === 0 ? null : (
                   <div className="sponsors">
                       {stats.sponsors.slice(0, 20).map(sponsor => (
                           <a href={sponsor.url} target="_blank" rel="noopener noreferrer"
                              title={sponsor.name ?? sponsor.login}>
                               <img src={sponsor.avatarUrl} alt={sponsor.login} loading="lazy"
                                    crossOrigin="anonymous"/>
                           </a>
                       ))}
                   </div>
               )}/>
    </RailSection>
)
