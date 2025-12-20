import css from "./BoxDebugView.sass?inline"
import {UUID} from "@opendaw/lib-std"
import {ArrayField, Box, Field, ObjectField, PointerField, PrimitiveField, Vertex} from "@opendaw/lib-box"
import {createElement, JsxValue, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "BoxDebugView")

export type Construct = {
    box: Box
}

export const BoxDebugView = ({box}: Construct) => {
    const content = <div style={{display: "contents"}}/>
    const uuidElement: HTMLElement = <h2>{UUID.toString(box.address.uuid)}</h2>
    const incoming = (vertex: Vertex) => `← ${(vertex.pointerHub.incoming().length)}`
    const render = (vertex: Vertex): JsxValue => (
        <div className="fields">
            <div className="type">
				<span>
					{vertex.isBox() ? vertex.name : vertex.isField() ? vertex.fieldName : ""}
				</span> <span className="pointer">{incoming(vertex)}</span>
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
                                        <span>{`${field.getValue()}`}</span> <span
                                        className="pointer">{incoming(field)}</span>
                                    </div>
                                ),
                                visitPointerField: (field: PointerField): JsxValue => (
                                    field.targetVertex.match({
                                        none: () => <div className="target">→ unset</div>,
                                        some: vertex => (
                                            <div className="target clickable" onclick={() => {
                                                uuidElement.textContent = UUID.toString(vertex.box.address.uuid)
                                                replaceChildren(content, render(vertex.box))
                                            }}>
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
                                    <div className="value"><span>⌾</span> <span
                                        className="pointer">{incoming(field)}</span></div>)
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