# Recording the demo

## Short GIF for the README (recommended)

[VHS](https://github.com/charmbracelet/vhs) types the commands from `qajitsu.tape` and records the terminal, so the
result is clean and repeatable.

```sh
brew install vhs                       # installs ttyd and ffmpeg too
pnpm build
node examples/demo-shop/scripts/setup-demo-repo.mjs
ollama pull gemma4:e2b                 # the demo plans with a local model
vhs docs/demo/qajitsu.tape             # writes docs/assets/qajitsu-demo.gif and .mp4
```

Long steps (model calls, the build) are recorded hidden, so the GIF stays short. If a step takes longer on your
machine, raise the `Sleep` after its `Hide`. Change the text, speed or theme in the tape and record again.

Show it in the main README:

```markdown
<p align="center"><img src="docs/assets/qajitsu-demo.gif" alt="QAJitsu in the terminal" width="900"></p>
```

Keep the GIF under about 10 MB (shorter tape, `Set Width 1100`, or fewer steps); GitHub renders it inline.

## A longer video with voice-over

For a walkthrough (2–4 minutes) record the screen instead:

1. Prepare the demo as above, open the terminal and `report.html` side by side, enlarge the font.
2. Record with QuickTime (File → New Screen Recording) or [OBS](https://obsproject.com/), with your voice.
3. Show: `qj fetch` → `qj plan` (the plan and its sources) → `qj run --build` → `report.html` with evidence →
   the same run with a seeded bug ending FAILED → `qj publish` preview.
4. Upload the MP4 by dragging it into a GitHub issue, PR or release description; GitHub hosts it and the link can
   go into the README. YouTube works too.

## Asciinema (interactive, copyable text)

`asciinema rec demo.cast`, run the commands, stop with Ctrl+D, `asciinema upload demo.cast`. Viewers can pause
and copy commands; `agg demo.cast demo.gif` turns it into a GIF.
