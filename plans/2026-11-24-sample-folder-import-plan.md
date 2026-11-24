# Import sample folders with their structure

## Goal

A folder from the file manager arrives in the sample browser with all its sub-folders, by drag and drop or by
picking the folder. Chrome, Safari, Firefox.

## Steps

1. **Read folders:** A dropped folder is read recursively (`webkitGetAsEntry`), every file keeps its relative path.
   Plain files behave as before. (`DragAndDrop.ts`, `FolderImport.ts`)
2. **Build the structure:** Group the files by sub-folder, import them, move them into the matching folder below the
   drop target (`LocalTree.move` creates missing folders). (`ResourceBrowser.tsx`)
3. **Pick a folder:** Context menu on the root or a folder → "Import Folder…" (`<input webkitdirectory>`), reuses step 2.
4. **Feedback:** A toast when no audio file was found instead of a silent no-op.
5. **One progress dialog:** `AssetService.importGroups` imports all groups under a single progress dialog and a single
   issue report. `importFiles` delegates to it. (`AssetService.ts`)

## Done when

- Unit tests for the recursive read and for `importGroups` are green.
- The test folder `musicradar-dirty-grime-samples` arrives with an identical structure in Chrome, Safari and Firefox.
- Non-audio files (`.DS_Store`, `.txt`) are skipped.

## Decided

- An existing folder of the same name is merged into.
- Samples are content-addressed (sha256): identical audio is one sample and stays in the first folder it appears in
  during the import. A folder holding nothing but such duplicates is not created.
