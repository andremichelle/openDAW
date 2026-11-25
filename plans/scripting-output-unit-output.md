# Scripting: output of the output unit

`project.output.output` threw `RootBox … is not instance of class AudioBusBox`. The output unit points at
`RootBox.outputDevice`, not at a bus, so the getter now returns `null` there, as the `Nullable` contract says.

Found while building an MCP bridge for the scripting API. Fix and test written with AI assistance and reviewed by me.
