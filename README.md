# opencode-web-stream

A live voice companion for OpenCode Web. It watches a real session, tells you
what is happening while it happens, listens while it talks, and turns what you
say into action in that same session.

```
you speak ──▶ recognizer ──▶ streamer decides ──▶ session acts
                                   │
session events ──▶ beats ──────────┘──▶ voice ──▶ you hear it, and can cut in
```

## What it does

- **Narrates in the present tense.** Tool activity is grouped into short
  windows and handed to a subagent — the `streamer` — which decides whether
  there is anything worth saying. Most of the time there is not, and it stays
  quiet.
- **Reads the answer as it is written.** The final reply is spoken sentence by
  sentence off the model's own token stream, not after it finishes. Code blocks
  and tables become one short notice instead of being read out.
- **Listens continuously, and lets you interrupt.** Speaking over the voice
  stops it within a frame. What you said then goes to the streamer, which works
  out whether it was a command, a question, background noise, or you thinking
  out loud.
- **Understands your project's names.** A lexicon of the workspace — file
  names, symbols, packages, branches — biases the recognizer and gives the
  streamer phonetically close candidates for anything mangled in transcription.
  French and English encoders both run, because that is how the speech actually
  comes out.
- **Acts, rather than describing.** An instruction is queued into the real
  session (or interrupts it, when you clearly want it to). A pending permission
  or question can be answered out loud. Everything lands in the web UI exactly
  as if you had typed it.
- **Asks when it is unsure.** Where two readings of a sentence lead to two
  different actions, it asks a short question instead of guessing.
- **Speaks your language, per session.** French or English follows what you
  last spoke in, with a voice for each. One switch, shared with the
  opencode-web-voice plugin's selector.

## Design

One principle: **mechanism in the code, judgement in the model.** The code
transports, windows, prioritizes and plays. It holds no list of interesting
tools, no stop-words, no confidence threshold, no intent patterns. Everything
that amounts to "what did they mean" is answered by the streamer, whose
behaviour lives in a prompt you can edit.

The exception is the one decision that cannot wait for a round trip: when you
start speaking over the voice, the audio stops immediately. What it meant still
goes to the model.

Full architecture, event contract, timings and edge cases: [AGENTS.md](AGENTS.md).

## Install

```bash
npm install && npm run build
cp agent/streamer.md ~/.config/opencode/agents/streamer.md
npm start
```

Point opencode-lens at `dist/plugin.js` and proxy `/__stream__` and `/ws/stream`
to the daemon. Speech runs through any OpenAI-compatible transcription and
synthesis endpoint; with none configured, the browser's own voice and
recognition take over. Setup for a local, fully offline stack is in
[AGENTS.md, section 10](AGENTS.md#10-local-setup-on-the-workstation).

## Develop

```bash
npm run typecheck   # daemon and cockpit
npm test            # 104 tests, no network, no model, no microphone
```

The integration suite drives the real daemon against a fake OpenCode server
speaking the real SSE and REST shapes, and a fake cockpit speaking the real
websocket protocol.
