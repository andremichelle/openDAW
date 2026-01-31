import { Lifecycle } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
import { createElement } from "@opendaw/lib-jsx"
import { Checkbox } from "@/ui/components/Checkbox"
import { Colors, IconSymbol } from "@opendaw/studio-enums"
import { Icon } from "@/ui/components/Icon"

export const OdieButton = ({ service, lifecycle }: { service: StudioService, lifecycle: Lifecycle }) => {
    return (
        <Checkbox
            lifecycle={lifecycle}
            model={service.layout.odieVisible}
            appearance={{
                activeColor: Colors.blue,
                tooltip: "Odie AI Assistant",
                cursor: "pointer"
            }}>
            <Icon symbol={IconSymbol.Robot} style={{ fontSize: "1.25em", lineHeight: "1" }} />
        </Checkbox>
    )
}
