import { Lifecycle } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
import { createElement } from "@opendaw/lib-jsx"
import { Checkbox } from "@/ui/components/Checkbox"
import { Colors } from "@opendaw/studio-enums"

export const OdieButton = ({ service, lifecycle }: { service: StudioService, lifecycle: Lifecycle }) => {
    return (
        <Checkbox
            lifecycle={lifecycle}
            model={service.odieService.visible}
            appearance={{
                activeColor: Colors.purple,
                tooltip: "Odie AI Assistant",
                cursor: "pointer"
            }}>
            <span style={{ fontSize: "1.25em", lineHeight: "1" }}>🤖</span>
        </Checkbox>
    )
}
