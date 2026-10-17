# Studio MCP

Runs openDAW scripts on a project file in Node, from a shell or as an MCP server, so that an agent can edit a project
without a browser. A script is written as in the studio's script editor: it loads the project with
`await openDAW.getProject()`, edits it and applies the changes with `project.openInStudio()`. The changes of one
script are one request, and `undo` takes back the newest applied request.

```sh
npx turbo run build --filter=@opendaw/studio-mcp...
node packages/studio/mcp/dist/cli.js init --dir song
node packages/studio/mcp/dist/cli.js run lead.ts --dir song
node packages/studio/mcp/dist/cli.js undo --dir song
```

As an MCP server on stdio, for example in Claude Code:

```sh
claude mcp add opendaw -- node /path/to/openDAW/packages/studio/mcp/dist/cli.js serve --dir /path/to/song
```

Scripts run in a Node worker thread with the rights of the user and an empty `process.env`. Only run scripts that you
would also run in a shell. Use one writer for each workspace: a script is refused when the project changed
while it ran, but two processes that save at the same moment are not detected. A request saves its record before the
project, and removes the record when the project cannot be saved. If the process stops between the two saves, undo
reports that the project changed and cannot take back that request or the requests before it.

## Architecture

* `src/Script.ts` checks a script with the compiler options and declaration files of the studio's script editor
  (`library.d.ts` and `api.declaration.d.ts`) and runs it in a worker thread with the `ScriptRunner`. The worker and
  the host connect with `ScriptConnection`, as in the studio.
* `src/Requests.ts` is the host. `applyUpdates` applies the update tasks of the script to the project and records the
  updates as `BoxEditing` does, so that `undo` can invert them. As in the studio, the changes are refused when the
  project changed while the script ran.
* `src/Workspace.ts`: a workspace is a directory with `project.od` and `requests/`, which keeps every script with its
  result.
* `src/Mcp.ts` and `src/Tools.ts`: the tools `run`, `undo` and `docs` (the scripting guide, or the declarations that
  mention a query) over newline-delimited JSON-RPC.
* `npm run build` bundles `dist/cli.js` and `dist/ScriptWorker.js` with esbuild, because Node cannot load the
  extensionless imports of the built packages. The bundles start with `console.debug = () => {}`, because the
  libraries announce themselves with `console.debug` and stdout must hold only JSON-RPC. The tests use the bundled
  worker too.

## Not covered yet

* Rendering and files: `renderMixdown`, `addSample` and `saveFile` reject, and `listSamples` gives no samples.
* Create scripts (`openDAW.newProject()`): `init` makes a new project.
* `console.debug` output: the libraries use it for their own messages, so it is dropped.
