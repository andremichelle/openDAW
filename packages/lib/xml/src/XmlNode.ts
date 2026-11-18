export interface XmlNode {
    readonly name: string
    readonly attributes: ReadonlyMap<string, string>
    readonly children: ReadonlyArray<XmlNode>
    readonly text: string
}
