import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {RailSection} from "@/ui/dashboard/RailSection"

const BUG = "https://github.com/andremichelle/openDAW/issues/new?template=bug_report.yml"
const FEATURE = "https://github.com/andremichelle/openDAW/issues/new?template=feature_request.yml"

export const HelpFeedback = () => (
    <RailSection title="Help & Feedback" vertical={true}>
        <button className="link" onclick={() => RouteLocation.get().navigateTo("/preferences")}>
            <Icon symbol={IconSymbol.System}/><span>Preferences</span>
        </button>
        <button className="link" onclick={() => RouteLocation.get().navigateTo("/manuals/")}>
            <Icon symbol={IconSymbol.Book}/><span>Manuals</span>
        </button>
        <a className="link" href={BUG} target="_blank" rel="noopener noreferrer">
            <Icon symbol={IconSymbol.Bug}/><span>Report a bug</span>
        </a>
        <a className="link" href={FEATURE} target="_blank" rel="noopener noreferrer">
            <Icon symbol={IconSymbol.Flask}/><span>Request a feature</span>
        </a>
    </RailSection>
)
