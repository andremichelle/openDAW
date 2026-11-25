import css from "./BoxDebugView.sass?inline"
import {UUID} from "@opendaw/lib-std"
import {ArrayField, Box, ByteArrayField, Field, ObjectField, PointerField, PrimitiveField, StringField, Vertex} from "@opendaw/lib-box"
import {createElement, JsxValue, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {MenuItem} from "@opendaw/studio-core"
import {Menu} from "@/ui/components/Menu.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"

const className = Html.adoptStyleSheet(css, "BoxDebugView")

const MAX_STRING = 128

const printValue = (field: PrimitiveField): string => {
    if (field instanceof ByteArrayField) {return `${field.getValue().byteLength} bytes`}
    if (field instanceof StringField) {
        const text = field.getValue()
        if (text.length === 0) {return "{empty}"}
        return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}… (${text.length} chars)` : text
    }
    return `${field.getValue()}`
}

export type Construct = {
    box: Box
}

export const BoxDebugView = ({box}: Construct) => {
    const content = <div style={{display: "contents"}}/>
    const uuidElement: HTMLElement = <h2>{UUID.toString(box.address.uuid)}</h2>
    const navigate = (target: Box): void => {
        uuidElement.textContent = UUID.toString(target.address.uuid)
        replaceChildren(content, render(target))
    }
    const incoming = (vertex: Vertex): JsxValue => {
        const pointers = vertex.pointerHub.incoming()
            .filter(pointer => pointer.targetAddress.mapOr(address => address.equals(vertex.address), false))
        if (pointers.length === 0) {return <span className="pointer">← 0</span>}
        const root = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
            ...pointers.map(pointer => MenuItem.default({label: `${pointer.box.name}/${pointer.address.fieldKeys}`})
                .setTriggerProcedure(() => navigate(pointer.box)))))
        const element: HTMLElement = (
            <span className="incoming" onpointerdown={(event: PointerEvent) => {
                event.stopPropagation()
                const rect = element.getBoundingClientRect()
                const menu = Menu.create(root)
                menu.moveTo(rect.left, rect.bottom + Menu.Padding)
                menu.attach(Layers.get(element).flyout)
            }}>{`← ${pointers.length}`}</span>
        )
        return element
    }
    const render = (vertex: Vertex): JsxValue => (
        <div className="fields">
            <div className="type">
				<span>
					{vertex.isBox() ? vertex.name : vertex.isField() ? vertex.fieldName : ""}
				</span> {incoming(vertex)}
            </div>
            {Array.from(vertex.fields()).map(field => {
                return (
                    <div className={Html.buildClassList("field", field.deprecated && "deprecated")}>
                        <span className="key">{field.fieldKey}</span>
                        <span
                            className="name">{field.deprecated ? `${field.fieldName} (deprecated)` : field.fieldName}
                        </span>
                        {
                            field.accept<JsxValue>({
                                visitPrimitiveField: (field: PrimitiveField): JsxValue => (
                                    <div className="value">
                                        <span>{printValue(field)}</span> {incoming(field)}
                                    </div>
                                ),
                                visitPointerField: (field: PointerField): JsxValue => (
                                    field.targetVertex.match({
                                        none: () => <div className="target">→ unset</div>,
                                        some: vertex => (
                                            <div className="target clickable" onclick={() => navigate(vertex.box)}>
                                                {`→ ${vertex.box.name}/${vertex.address.fieldKeys}`}
                                            </div>
                                        )
                                    })
                                ),
                                visitObjectField: (field: ObjectField<any>): JsxValue => (
                                    <div className="object">
                                        {render(field)}
                                    </div>
                                ),
                                visitArrayField: (field: ArrayField): JsxValue => (
                                    <span classNam="value">N:{field.size()}</span>),
                                visitField: (field: Field): JsxValue => (
                                    <div className="value"><span>⌾</span> {incoming(field)}</div>)
                            })
                        }
                    </div>
                )
            })}
        </div>
    )
    replaceChildren(content, render(box))
    return (
        <div className={className}>
            {uuidElement}
            {content}
        </div>
    )
}