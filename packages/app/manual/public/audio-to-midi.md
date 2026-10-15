# Audio to MIDI

MuScriptor converts recorded music into editable MIDI notes, with a separate track for each detected instrument group.
This experimental feature runs locally and needs a browser with WebGPU and FP16 support. It has been tested in Chrome.

## Convert an audio file

1. Choose **Audio to MIDI** on the dashboard, or **openDAW → Import → Audio to MIDI (MuScriptor)...**.
2. Pick an audio file. openDAW adds it to a source audio track.
3. Read the model information and choose **Convert**.

Before conversion, a prominent **Model download: 616.3 MB** notice shows the first-use download size.
The files download from Hugging Face and are cached in this browser for later conversions.
Download progress also shows the total size in MB; cached loading is labeled separately.
Your audio is processed on your computer and is not uploaded. Progress shows downloading, model loading and transcription.

## Convert an existing clip

Right-click an audio region in the timeline or an audio clip in the session grid, then choose **Convert Instruments to MIDI...**.
To convert only a section, split or trim the audio region first. The command uses the right-clicked clip's content.

## Work with the result

Each detected instrument group gets a new track and aligned MIDI region or clip directly below the source.
The original audio stays available for comparison. Session clips retain their slot and loop setting.
One **Undo** removes all generated tracks; **Redo** restores them. The file import itself is a separate edit.
**Cancel** stops pending conversion without creating partial MIDI tracks.

Track names describe the model's instrument classification. The tracks initially use **Neon** for note audition;
select suitable instruments afterward, including a drum kit for the **Drums** track. Transcription recovers notes,
not the original sound, effects or exact DAW track layout. Multiple parts classified as the same instrument group share a track.

Check the notes and labels before using the result. Dense mixes, similar timbres, effects and sustained notes can produce
extra or missing notes or incorrect instrument assignments. Note velocities are fixed because this model's output uses
binary note-on/note-off velocity tokens. Conversion runs independently of playback; this version has no live capture or growing preview.

The [MuScriptor model weights](https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx) are licensed under
**CC BY-NC 4.0 (non-commercial)**. This is separate from openDAW's software license.
