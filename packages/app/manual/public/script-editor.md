# Script Editor

The script editor lets you write a few lines of TypeScript that create a new project or change the one you have open.
You find it under openDAW menu > Script Editor.

The complete documentation lives at [opendaw.studio/docs/scripting](/docs/scripting/), with a guide, a cookbook and
the reference of everything a script can touch. This page covers the editor itself.

## Running

The File menu has two starting points, **New Create Script** and **New Edit Script**, with the necessary lines already
in place. Auto-completion is your guide while typing. Type `project.` and the editor lists everything that is
available, with a short description for each property and method.

Press **Run**. A script that creates a project opens it in the studio. A script that edits the open project applies
its changes as a single undo step, so you can take them back with one undo.

## Saving scripts

Scripts are saved in your browser with a name and a description and are included in the [cloud backup](/manuals/cloud-backup).

- **Save** (Cmd/Ctrl + S) and **Save As...** (Cmd/Ctrl + Shift + S) are in the File menu.
- **Scripts** (Cmd/Ctrl + O) opens the list of your scripts, where you can open, rename and delete them.
- **Import Script...** and **Export Script...** read and write plain `.ts` files.

## Community scripts

**Community Scripts...** in the File menu opens scripts shared by the openDAW community, for example an acid line
with drums, a generated sample on an audio track, a wavetable for Nano, an inventory of the open project, a cleanup
script and a mixdown. Search by name, author or tag, preview the code and click **Open** to load one as a new,
unsaved script. Paste a GitHub link to a script, a folder or a pull request into the field at the bottom to load a
script straight from GitHub, so you can try it before it is published. **How to contribute?** explains how to share
your own. Many of these scripts are explained in the [cookbook](/docs/scripting/guide/09-cookbook/).

The Starter script comes with the editor. Example scripts from earlier versions stay in your list until you delete
them.

When you paste a script that starts with imports, everything before its first comment line is removed, because the
editor provides the API itself.
