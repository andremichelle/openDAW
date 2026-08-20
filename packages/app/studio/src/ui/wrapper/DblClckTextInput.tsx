import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {assertInstanceOf, isDefined, Option, Point, PrintValue, Provider} from "@opendaw/lib-std"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Events} from "@opendaw/lib-dom"

type Construct = {
    resolversFactory: Provider<PromiseWithResolvers<string>>
    provider: Provider<PrintValue>
    location?: Provider<Point>
    numeric?: boolean
}

export const DblClckTextInput = ({
                                     resolversFactory,
                                     provider,
                                     location,
                                     numeric
                                 }: Construct, [element]: ReadonlyArray<JsxValue>) => {
    assertInstanceOf(element, Element)
    Events.subscribeDblDwn(element, () => {
        const rect = element.getBoundingClientRect()
        const option = Option.from(provider)
        if (option.isEmpty()) {return}
        const {value, unit} = option.unwrap()
        const point: Point = isDefined(location) ? location() : {x: rect.left, y: rect.top + (rect.height >> 1)}
        element.ownerDocument.body.appendChild(
            <FloatingTextInput position={point}
                               value={value}
                               unit={unit}
                               numeric={numeric}
                               resolvers={resolversFactory()}/>
        )
    })
    return element
}