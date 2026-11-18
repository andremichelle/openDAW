_This package is part of the openDAW SDK_

# @opendaw/lib-xml

Typed XML binding: classes declare their attributes and child elements with decorators, `Xml.read` turns a document into
frozen instances of them and `Xml.write` turns instances back into a document. It has its own reader and writer and needs
no DOM, so it runs in the browser, in workers and in node.

### Schema

Elements are written in declaration order, inherited fields first. A child is either a fixed element name with one class
(`name`), or a choice of classes picked by their `@Xml.Class` tag. Lists can sit inside a wrapper element (`wrapper`).

```typescript
import {Xml} from "@opendaw/lib-xml"

export enum Unit {LINEAR = "linear", BPM = "bpm"}

export abstract class NameableSchema {
    @Xml.Attribute("name", Xml.StringOptional) declare readonly name?: string
}

@Xml.Class("RealParameter")
export class RealParameterSchema extends NameableSchema {
    @Xml.Attribute("unit", Xml.Enum(Unit, true)) declare readonly unit: Unit
    @Xml.Attribute("value", Xml.NumberOptional) declare readonly value?: number
}

@Xml.Class("Note")
export class NoteSchema {
    @Xml.Attribute("time", Xml.NumberRequired) declare readonly time: number
    @Xml.Attribute("key", Xml.IntRequired) declare readonly key: number
}

@Xml.Class("Project")
export class ProjectSchema {
    @Xml.Attribute("version", Xml.StringRequired) declare readonly version: string
    @Xml.Text("Title") declare readonly title?: string
    @Xml.Child(() => RealParameterSchema, {name: "Tempo", required: true}) declare readonly tempo: RealParameterSchema
    @Xml.Children(() => NoteSchema, {wrapper: "Notes"}) declare readonly notes: ReadonlyArray<NoteSchema>
}
```

### Writing and reading

```typescript
const project = Xml.element({
    version: "1.0",
    title: "Demo",
    tempo: Xml.element({name: "Tempo", unit: Unit.BPM, value: 120}, RealParameterSchema),
    notes: [Xml.element({time: 0, key: 60}, NoteSchema)]
}, ProjectSchema)

const xml = Xml.write(project)
const {value, issues} = Xml.read(xml, ProjectSchema)
```

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0">
  <Title>Demo</Title>
  <Tempo name="Tempo" unit="bpm" value="120"/>
  <Notes>
    <Note time="0" key="60"/>
  </Notes>
</Project>
```

`Xml.read` returns the elements and attributes it did not know in `issues`. Malformed XML, a missing required
attribute or element and a value its codec rejects (`Xml.IntRequired` and `"1.5"`) fail with the location.

### Codecs

`String`, `Number` (xs:double, `INF` and `NaN` included), `Int` (xs:int), `Bool` (`true`, `false`, `1`, `0`), each as
`Required` and `Optional`, plus `Xml.Enum(values, required)`, `Xml.List(codec, required)` and `Xml.codec(required, parse, format)`
for any other text form.

`Xml.Element`, `Xml.ElementRef`, `Xml.toElement` and `Xml.pretty` are kept for existing schemas and are deprecated.