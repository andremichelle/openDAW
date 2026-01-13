import css from "./IconsPage.sass?inline"
import {createElement, Frag, PageContext, PageFactory} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Html} from "@moises-ai/lib-dom"
import {IconSymbol} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "IconsPage")

export const IconsPage: PageFactory<StudioService> = ({}: PageContext<StudioService>) => (
    <div className={className}>
        <h1>Icons</h1>
        <div>{Object.keys(IconSymbol)
            .filter(key => !isNaN(Number(IconSymbol[key as any])))
            .sort()
            .map(key => (
                <Frag>
                    <label>{key}</label>
                    <Icon symbol={IconSymbol[key as any] as unknown as IconSymbol}/>
                    <div className="background">
                        <Icon symbol={IconSymbol[key as any] as unknown as IconSymbol}/>
                    </div>
                </Frag>
            ))
        }</div>
    </div>
)