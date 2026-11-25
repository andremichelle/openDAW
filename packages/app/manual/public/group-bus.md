# Group Bus

A group bus mixes several tracks into one channel. In the timeline and the mixer it holds its tracks like a folder
that you can fold. A group bus is an [Audio Bus](/manuals/audio-bus), every bus in a project is a group bus.

---

## 1. Create a Group Bus

1. Select the tracks in the timeline or the mixer
2. Press **Cmd+G** (Ctrl+G on Windows and Linux), or right-click and choose **Create Group Bus**
3. Type a name

The selected tracks move into the new group bus and play through it. Group buses can sit inside other group buses,
for example all drums in one group bus with the cymbals in a group bus of their own inside it.

A track whose output goes to a bus sits inside that bus. Choosing **New Output Bus...** in a channel's **Output**
selector creates a group bus as well.

---

## 2. Selecting Tracks

- **Click** selects a track and opens it in the device panel
- **Shift+Click** selects the range from the track in the device panel
- **Cmd+Click** (Ctrl+Click) adds or removes a single track

The track shown in the device panel has a light wash. Commands like Create Group Bus and Delete work on all selected
tracks.

---

## 3. Moving Tracks

- Drag a track by its handle onto a group bus to move it in
- Drop it between two tracks to place it there
- Drag it to the left to move it out of its group bus, one level per step
- Right-click and choose **Move Out of Group Bus**
- Change the track's **Output** in the mixer

---

## 4. Mixing

A group bus is a channel like any other. It has its own effects, volume, pan, mute, solo, sends and output. Effects on
the group bus process the sum of its tracks.

**Remove Group Bus (Keep Tracks)** (Cmd+Shift+G, Ctrl+Shift+G) removes the group bus and puts its tracks where it was,
one level up.

---

## 5. Folding

Click the arrow next to the name of a group bus to fold or unfold it, in the timeline or in the mixer. The context menu
of a group bus in the mixer offers **Collapse Group Bus** and **Expand Group Bus**.

A folded group bus shows thin lines for the regions inside it, so you still see where things happen. Selected tracks
that disappear in a fold are deselected.

---

## 6. Clips

In the clips area a group bus row has one cell per column. Its play button launches the clips of all tracks inside the
group bus in that column, and stops them again.

---

## 7. Copy and Duplicate

Group buses cannot be copied. Use **Duplicate AudioUnit** in the track header menu, which copies the group bus with
all its tracks. A duplicate gets a name of its own, for example "Drums 2".

---

## 8. Live Rooms

In a [live room](/manuals/live-rooms) every participant folds group buses and resizes tracks for themselves. Your view
does not change what the others see.

---

## See Also

- [Audio Bus](/manuals/audio-bus)
- [Mixer](/manuals/mixer)
