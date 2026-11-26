# opencode-web-stream

A live voice companion for OpenCode Web. It watches a real session, says what
is happening while it happens, listens continuously, and turns speech into
action inside that same session.

This file is the contract for anyone — human or agent — working on this
repository. Read section 1 before changing anything.

---

## 1. The one principle

**Mechanism in the code, judgement in the model.**

The code transports, windows, prioritizes, plays and measures. It never decides
what matters. Every "is this interesting / did they mean this / should we
interrupt" question belongs to the `streamer` agent, which has the context to
answer it and can be improved by editing prose instead of shipping a release.

Concretely, the following are forbidden in this codebase:

- Lists of tools classified as interesting or boring.
- Word lists: stop-words, filler words, noise phrases, command keywords.
- Hardcoded spoken phrases, refusal templates (`phrases.json`), or instructional prompt prose inside `.ts` files. All prompts and classification criteria live externally in `agent/streamer.md` and `agent/decision.prompt.json`.
- Arbitrary time/length cutoffs (`beatTimeoutMs`, `voiceTimeoutMs`, `tts.timeoutMs`, `stt.timeoutMs`, `maxUtteranceMs` default to `0` = unbounded unless explicitly preempted or cancelled).
- Confidence thresholds or substring/word-count heuristics that silently discard what the user said.
- Pattern matching on transcripts to detect intent or echo.
- Language-locked assumptions: every user-facing utterance is generated dynamically by the model in whatever language the user just spoke.
- Anything that answers "what did they mean" without asking the model.

What the code *is* allowed to decide:

- **Timing.** When a window closes, when an utterance is too old to be worth
  saying, how long to wait before an injection fires.
- **Ordering.** Which of two pending utterances is more urgent.
- **Signal.** Whether the microphone is picking up energy above the room's
  noise floor. That is physics, not interpretation.
- **One reflex.** When the user speaks over the voice, cut the audio
  immediately. Waiting for a round trip to decide would make barge-in feel
  broken. What that speech *meant* still goes to the model.

Where an algorithm is needed, use a real one from a library rather than an
approximation: ICU for segmentation, talisman for phonetics, marked for
markdown, pino for logs. Hand-rolled approximations of solved problems are how
heuristics creep back in.

---

## 2. Shape

```
browser (Lens plugin)          daemon (this repo)              opencode serve
┌──────────────────────┐      ┌──────────────────────┐       ┌──────────────────┐
│ mic + VAD + WAV 16k  │      │ SSE watcher          │◀──────│ /api/event       │
│ live interim + AEC   │◀────▶│ session state machine│       │                  │
│ TTS queue + pause/   │  ws  │ beat windows         │──────▶│ /api/session/... │
│   exact ms resume    │      │ streamer sessions    │       │   prompt, abort, │
│ scrollable feed strip│      │ workspace + Hex lex. │       │   permissions    │
└──────────────────────┘      └──────────┬───────────┘       └──────────────────┘
                                         │
                      ┌──────────────────┼──────────────────┐
                      ▼                  ▼                  ▼
           Ollaya (largha ~45ms)   Hex Orukeet STT     Built-in edge-tts WS
            /v1/systemone          (or browser/URL)    (no deflate + warm WS)
```

- **`src/daemon`** — the brain. Subscribes to the OpenCode event bus, keeps one
  state machine per live session, routes triage via Ollaya `largha` and
  judgement via `streamer`, acts on the session through the REST API, serves the cockpit.
- **`src/browser`** — the cockpit. Audio in (16 kHz WAV + live Web Speech interim preview),
  audio out (`AudioBuffer` with exact-offset pause/resume + WebRTC loopback AEC),
  scrollable `.ows-feed` strip with `stt:hex ↔ stt:web` toggle. Ships as `dist/plugin.js`, loaded by opencode-lens.
- **`src/shared`** — the wire protocol (`protocol.ts`) and OpenCode event shapes, imported
  by both sides so a change breaks the build rather than production. Zero hardcoded phrase files.
- **`agent/streamer.md`** & **`agent/decision.prompt.json`** — external model prompts and System-One criteria.
  All behavioural changes belong here, never inside `.ts` code.
  In addition to installing `agent/streamer.md` for OpenCode, the daemon seeds the contract directly into new streamer sessions so host-side agent caching never causes prompt drift.

There is deliberately **no OpenCode plugin**. Everything a server-side plugin
could observe is on the event stream, and a daemon survives OpenCode restarts,
serves every project at once, and can be developed without a plugin reload.

### Persistence

`~/.local/share/opencode-web-stream/registry.json` holds the main-session →
streamer-session bindings, per-session preferences, and learned voice aliases.
It is written atomically and reloaded at startup, which is what makes restarts
invisible.

---

## 3. Event contract

### Consumed from OpenCode (`GET /global/event`, SSE)

| Event | Use |
| --- | --- |
| `message.updated` (user) | New prompt from the user; closes the current beat window. |
| `message.part.delta` (`field: "text"`) | The answer as it is written. Split into sentences and spoken live. |
| `message.part.updated` (tool) | Tool calls with input, output and title: the material of a beat. |
| `session.status` | `busy` / `idle` / `retry` drive the state machine. |
| `permission.asked`, `question.asked` | Blocking events: highest priority, preempt narration. |
| `session.error` | Spoken, except `MessageAbortedError`, which is our own interrupt. |
| `session.compacted` | One short notice, then the streamer's context is reseeded. |
| `session.created` with `parentID` | Subagent: folded into the parent's narration, never narrated twice. |
| `todo.updated` | The agent's plan, used as beat context. |
| `file.edited`, `vcs.branch.updated` | Debounced lexicon refresh. |

Reasoning deltas are never spoken: only parts whose type is `text`.

### Acted on OpenCode (REST)

| Call | Use |
| --- | --- |
| `POST /session` | Create the streamer session. |
| `POST /session/:id/message` | Ask the streamer (with `agent`, `model`), or seed it with `noReply: true`. |
| `POST /session/:id/prompt_async` | Inject into the main session without blocking. |
| `POST /session/:id/abort` | Interrupt mode, before injecting. |
| `POST /session/:id/permissions/:pid` | Answer a permission by voice. |
| `POST /question/:rid/reply` | Answer a question by voice. |
| `POST /session/:id/summarize` | Compact the streamer session when it grows. |

A prompt sent while the session is busy is **queued** by OpenCode and picked up
at the next step, which is what `queue` mode relies on. Only `interrupt` mode
aborts first.

### Streamer grammar

The model answers with one decision block. The parser is tolerant of case,
quoting and stray prose; anything it cannot read becomes `<quiet/>`, so a
malformed answer is never read aloud by accident.

```
<quiet/>
<say>…</say>                                   narration or acknowledgement
<reply>…</reply>                               direct answer, agent untouched
<clarify>…</clarify>                           ask before acting
<inject mode="queue|interrupt">…</inject>      instruction for the main agent
<permission answer="once|always|reject"/>
<question answers='[["Label"]]'/>
<control action="mute|unmute|stop|repeat|slower|faster|digest|full"/>
<learn heard="…" canonical="…"/>
```

Speakable tags are also read **incrementally**: as the streamer's own text
streams in, the sentence splitter releases finished sentences to the player, so
the voice starts before the model has finished writing.

### Cockpit protocol

`src/shared/protocol.ts` is the single source of truth, versioned by
`PROTOCOL_VERSION`. A cockpit on a different version is told to reload rather
than left to misbehave. The daemon's messages carry state, speech, cancels and
lexicon updates; the cockpit's carry transcripts, barge-ins, playback receipts
and preferences.

---

## 4. Timing and priority

Defaults live in `src/daemon/config.ts` and every one of them is configurable.

| Knob | Default | Why |
| --- | --- | --- |
| Beat window | 2.5 s or 6 tools | Short enough to stay present tense. |
| Beat time to live | 9 s | A narration that arrives after the moment is noise. |
| Streamer / STT / TTS / Decision timeouts | `0` (unbounded) | Never abort reasoning, dictation, or synthesis on an arbitrary timer; only preemption or cancellation stops them. |
| Injection delay | 1.5 s | The window in which the cockpit can cancel it. |
| Blocked repeat | 45 s, twice | Being stuck without knowing it is the worst failure mode. |
| Speech confirmed | 220 ms (450 ms ducked) | Below that it is a click, not a word; higher bar while speaking prevents speaker pops from interrupting. |
| Silence hangover | 550 ms | End of utterance without cutting people off mid-thought. |
| Max utterance | `0` (unbounded) | Never cut off long natural speech by clock. |
| False barge-in | 2.2 s | No words after an interruption: resume from exact millisecond (`pausedItem.resumeOffsetSec`). |

Speech priority: `blocked` (40) > `system` (35) > `reply` (30) > `answer` (20) >
`beat` (10). A strictly higher priority preempts playback. Chunks of one answer
carry a stream id and sequence number so they can never overtake each other.

---

## 5. The workspace lexicon

Recognizers do not know this project's names. The lexicon is what lets the
streamer put them back.

**Sources:** file and directory names, declarations found in source files,
package/script/dependency names, git branches, headings and inline code of the
project's own docs, plus aliases the streamer has taught us via `<learn>`.

**Ranking is statistical, never editorial.** Each term scores
`structural weight × frequency × inverse document frequency` over the workspace
itself. A word that appears in half the files scores near zero; a name that
identifies one part of the project scores high. This is why there is no
stop-word list and why one must never be added: generic words are excluded by
the arithmetic.

**Three consumers:**
1. The recognizer, biased with the top terms (`recognition.phrases` in Chrome,
   or the Whisper `prompt` on the server side).
2. The daemon, which attaches phonetically similar candidates to each
   transcript. French (Phonex, Sonnex, FONEM) and English (Double Metaphone)
   encoders both run, because the speech is French carrying English
   identifiers.
3. The streamer, which receives the vocabulary once at startup as context.

The candidates are suggestions. Only the streamer decides what was said.

---

## 6. Languages

Speech here is French carrying English identifiers, and sometimes plain
English. Two decisions follow.

**The session language is what the user last spoke in.** The recognizer says
which language it ran in (`fr-FR`, `en-US`), or Whisper reports what it
detected when no language is pinned. That code is stored per session, briefed
to the streamer, stamped on every utterance, and used to pick the voice —
`tts.voices` maps codes to voices, `tts.voice` is the fallback. The streamer's
prompt tells it to answer in the user's language, so the chain is consistent
end to end.

**Per-sentence language detection is not used.** Two trigram detectors were
measured on the sentences this system actually produces. « Je patche le hook
et je relance npm test » came back as English with full confidence; « Let me
check the daemon config first » came back as French. Code-switched technical
speech defeats them, and a wrong guess would put an English voice on a French
sentence mid-answer. A reliable signal the user controls beats a clever one
that is wrong a quarter of the time.

**One switch for both plugins.** The cockpit reads and writes the language
selector of the opencode-web-voice plugin (`opencodeWebVoiceLang`, and its
`<select>` when present), so pinning French there pins it here. Its own chip
cycles `fr → en → auto` and pushes the choice back into that selector. `auto`
means Whisper detects; the browser recognizer, which cannot detect, then runs
in the navigator's language.

---

## 7. Edge cases the implementation must keep handling

Each of these is covered by a test; treat the list as a specification.

| Situation | Expected behaviour |
| --- | --- |
| Live enabled before any prompt | Streamer created, context seeded with `noReply`, no model call yet. |
| Live enabled on the new-session page | Armed against the directory in the URL; no session lookup, no model call. |
| Speaking with no session yet | The session is created, the cockpit is moved onto it, then the ordinary path runs. |
| No directory in the URL | Button shows `noDir` state; daemon rejects `live` cleanly with `no_directory` error code. |
| Browser reload | Daemon keeps the state; the cockpit resyncs without replaying speech. |
| OpenCode restart | Binding survives; a 404 on the streamer session recreates it. |
| Daemon restart | Registry reloaded, SSE resubscribed. |
| Two tabs or two devices | One speaker elected (visible, most recent); others display only. |
| Several live sessions | Voice on the focused one; the others surface blocking events with `sessionLabel`. |
| `task` subagents | Folded into the parent; beats tagged with the subagent. |
| Permission or question pending | Preempts narration, repeated twice, answerable by voice. |
| Provider retry | Announced once per episode. |
| Compaction / system failure | Emits `[SYSTEM]` event so `streamer` phrases the notice dynamically in the user's language; context reseeded. |
| Streamer session grows | Summarized automatically past the prompt budget. |
| Huge tool output | Truncated before it reaches the model. |
| Forty reads in a row | Windowed; a stale beat is dropped rather than spoken late. |
| Answer delivery | Default `answer.mode = "digest"`: main-session written answers are never piped raw to TTS; `streamer` presents them conversationally via `[ANSWER]` in the user's active language. |
| User speaks over the voice | Audio pauses immediately (`pausedItem` + `resumeOffsetSec`); false barge-in resumes from the exact millisecond. |
| Microphone hears the voice | Single-path WebRTC loopback echo cancellation (`setLoopbackActive`), ducked threshold (+900 ms tail), and `streamer` sees `last_spoken` in `[VOICE]` to ignore echoes in any language. |
| Hex `no-speech` on ambient sound | Treated cleanly as empty transcript (`{ text: "" }`), never disables Hex STT. |
| User asks for action / lookup | **Action + Speech in parallel:** whenever facts are not already in context, `streamer` MUST emit `<inject>` + `<say>` together, NEVER promise to check inside `<reply>` alone. |
| Cough, "hmm", noise | Discarded by duration, then by the streamer. |
| Unknown term | Streamer picks the likeliest and says so; `<learn>` makes it permanent. |
| Injection while busy | Queued and picked up next step; `interrupt` aborts first. |
| Daemon unreachable | Button disabled with a reason, exponential backoff, no audio work started. |
| Server TTS down | Automatic fallback to the browser voice. |
| Server STT down | Automatic fallback to browser recognition, mid-session. |
| Streamer unreachable | The raw transcript is queued rather than lost. |
| Streamer answers off-format | Parsed as `<quiet/>` and logged; never read aloud. |
| Live disabled | Streamer dormant, zero model calls, session kept for next time. |

### Two rules the cockpit must keep

**The observer must never react to its own writes.** The composer is replaced
on navigation, so the whole document is watched; painting also writes to the
document, and `setAttribute` queues a mutation record even when the value is
unchanged. Unguarded, that is an infinite loop that freezes the tab. Three
things prevent it, and all three are load-bearing: `paint()` writes through
`setAttr`/`setText`, which read before writing; a paint in progress
short-circuits the observer callback; and mutations on the cockpit's own nodes
are filtered out. Any new DOM write in the cockpit goes through those helpers.

**An instruction must land where the user can see it.** Injection goes through
`prompt_async` on a real session, so the message appears in the web UI exactly
as if it had been typed. On the new-session page there is no session yet: the
daemon creates one, sends `navigate`, and the cockpit follows with
`pushState` plus a `popstate` event, falling back to a real load if the app's
router does not follow. Never simulate typing into the composer.

---

## 8. Logging and debugging

Logs follow the usual level ladder (`trace` … `fatal`) on **pino**, one JSON
object per line on stdout, so `journalctl -u opencode-web-stream -o cat | jq`
works with no custom parser. Every logger carries a `scope`, and long-lived
context (session id, directory) is bound once with a child logger rather than
repeated at each call site.

```bash
OPENCODE_WEB_STREAM_LOG=debug OPENCODE_WEB_STREAM_PRETTY=1 npm start   # readable
journalctl --user -u opencode-web-stream -f -o cat | jq -c 'select(.scope=="orchestrator")'
curl -s localhost:8765/api/logs | jq -r '.[] | "\(.level)\t\(.scope)\t\(.msg)"'
curl -s localhost:8765/api/status | jq                                  # engines, sessions
```

Passwords and authorization headers are redacted by the logger itself.

In the browser, `window.__opencodeWebStream.logs()` returns the cockpit's ring
buffer, and `log.setLevel("debug")` raises verbosity without a rebuild.

---

## 9. Working on this repository

```bash
npm install
npm run typecheck       # both targets: daemon (Node) and cockpit (DOM)
npm test                # unit + integration, against a fake OpenCode server
npm run build           # dist/daemon/**, dist/plugin.js
npm start               # run the daemon
```

Tests run against `tests/helpers/fake-opencode.mjs`, which speaks the real SSE
and REST shapes. Nothing in the suite requires a running OpenCode, a model, a
microphone or a network.

When you add behaviour:

- If it involves judgement or wording, it belongs in `agent/streamer.md` or `agent/decision.prompt.json` — **never** in code.
- Never add arbitrary timeouts, stopword lists, or text heuristics.
- If it changes the wire, bump `PROTOCOL_VERSION`.
- If it is an edge case, add a row to section 7 and a test alongside it.
- **Always run real end-to-end verification before claiming done:** `npm run typecheck && npm test` (unit + integration), restart `opencode-web-stream` and `opencode-web-lens`, verify live HTTP/WS endpoints (`/api/status`, `/api/tts`, `/api/stt` with both speech & silent WAV), test real action injection (`<inject>` + `<say>`) against OpenCode, and inspect the live browser cockpit UI.

---

## 10. Deploying on the workstation

Everything below runs on the machine; nothing leaves it. Four pieces have to
agree: the daemon, the Lens proxy, the speech engines, and the streamer agent.
Do them in this order, and verify each one before moving on — both deployment
failures so far were a piece that looked deployed and was not.

### 10.1 Build

```bash
cd ~/.agents/skills/k-opencode/scripts/plugins/web/opencode-web-stream
npm ci          # or pnpm install --frozen-lockfile
npm run build   # writes dist/daemon/** and dist/plugin.js
npm test        # optional, ~5 s, no network or microphone needed
```

`dist/` is not committed, so this step is mandatory on every machine and after
every pull.

### 10.2 The daemon

```ini
# ~/.config/systemd/user/opencode-web-stream.service
[Unit]
Description=OpenCode Web Stream daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.agents/skills/k-opencode/scripts/plugins/web/opencode-web-stream
Environment="OPENCODE_URL=http://127.0.0.1:40977"
Environment="OPENCODE_WEB_STREAM_LOG=info"
ExecStart=/home/kpihx/.local/share/fnm/node-versions/v24.18.0/installation/bin/node dist/daemon/index.js
ExecStartPost=/bin/sh -c 'for i in $(seq 10); do curl -sf http://127.0.0.1:8765/health && exit 0; sleep 1; done; exit 1'
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`ExecStart` needs an absolute interpreter path (`which node`) because a user
unit does not load the shell profile, so a version manager's `node` is not on
its `PATH`. `OPENCODE_URL` must be the port `opencode serve` actually listens
on — the same one Lens proxies to.

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-web-stream
```

**Verify** before going further:

```bash
curl -s localhost:8765/health | jq
# { "status": "ok", "opencode": true, ... }  ← opencode:true means the event stream is connected
```

`opencode: false` means the daemon is up but cannot reach OpenCode: check
`OPENCODE_URL`.

### 10.3 The Lens proxy

The cockpit only ever talks to its own origin: HTTP under `/__stream__/` and a
WebSocket at `/ws/stream`. The Lens proxy bridges both to the daemon, which is
why the Tailscale HTTPS name works with no extra configuration.

`lens/lens-proxy.mjs` is the proxy already in service with one change: the
daemon address is read from `OPENCODE_WEB_STREAM_TARGET` (default
`http://127.0.0.1:8765`) instead of being written twice in the file. Copy it
over `opencode-lens/scripts/lens-proxy.mjs`; nothing else in it moved, so the
other plugins are unaffected.

Register the plugin alongside the others in the comma-separated
`OPENCODE_WEB_PLUGINS` of the `opencode-lens` unit, pointing at the **manifest**,
not at the bundle:

```ini
Environment="OPENCODE_WEB_PLUGINS=…/opencode-web-voice/lens.plugin.json,…/opencode-web-stream/lens.plugin.json"
```

> **Lens reads the bundle once, at startup, and keeps it in memory.** A rebuild
> alone changes nothing in the browser: the proxy keeps serving the previous
> code, which makes a fixed bug look unfixed. Every deploy of the cockpit is
> therefore two commands, never one:
>
> ```bash
> npm run build && systemctl --user restart opencode-lens
> ```

**Verify**, from the browser, on the Tailscale address:

```bash
curl -sk https://kpihx-ubuntu.tail2527bd.ts.net:2443/__stream__/health | jq
```

Then open the page and look for the waveform button in the composer's action
row. If it is missing, the bundle was not injected: check the manifest path and
restart Lens.

### 10.4 Speech engines

Any OpenAI-compatible endpoint works. On an Intel Arc integrated GPU with 32 GB
of shared memory, [speaches](https://github.com/speaches-ai/speaches) serves
both transcription and synthesis from one container:

```bash
docker run -d --name speaches --restart unless-stopped \
  -p 8000:8000 --device /dev/dri \
  -v ~/.cache/huggingface:/home/ubuntu/.cache/huggingface \
  ghcr.io/speaches-ai/speaches:latest-cpu

# Pull one model for each direction.
curl -s -X POST localhost:8000/v1/models/Systran/faster-whisper-large-v3
curl -s -X POST localhost:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

Defaults in `config.ts` already point at `127.0.0.1:8000` with
`Systran/faster-whisper-large-v3`, Whisper language detection on, the French
Kokoro voice `ff_siwis` and the English one `af_heart`. Override per machine in
`~/.config/opencode-web-stream/config.json`:

```json
{
  "opencode": { "url": "http://127.0.0.1:40977" },
  "speech": { "languages": ["fr", "en"], "default": "fr" },
  "stt": { "url": "http://127.0.0.1:8000/v1/audio/transcriptions", "model": "Systran/faster-whisper-large-v3", "language": "auto" },
  "tts": { "url": "http://127.0.0.1:8000/v1/audio/speech", "model": "speaches-ai/Kokoro-82M-v1.0-ONNX", "voices": { "fr": "ff_siwis", "en": "af_heart" }, "voice": "ff_siwis", "speed": 1.05 },
  "streamer": { "model": "opencode-go/muse-spark-1.3-contributor" }
}
```

The config file is read at startup, so `systemctl --user restart
opencode-web-stream` after editing it.

**Verify** that the daemon found both engines:

```bash
curl -s localhost:8765/api/status | jq '{stt: .stt, tts: .tts, speech: .speech}'
# engine "server" on both means local speech; "browser" means the daemon could
# not reach the endpoint and the cockpit will use the browser's own voice.
```

Notes for this hardware:

- On the Core Ultra 7 155H, `large-v3` transcribes a short utterance in well
  under a second on CPU. If it drags, `distil-large-v3` or `medium` are the
  next steps down; quality on French identifiers matters more than raw speed
  here, because the streamer corrects what the recognizer misses.
- Kokoro on CPU produces the first audio chunk in roughly a second. Piper via
  the same OpenAI-compatible interface is the choice if sub-100 ms matters more
  than the voice.
- The Arc iGPU helps through OpenVINO; the CPU image is the reliable starting
  point and the one the defaults assume.
- Set both endpoints to `""` to disable server speech entirely: the cockpit
  then uses the browser's own recognition and synthesis, with no other change.

### 10.5 The streamer agent

Copy the prompt into the agents directory OpenCode reads, **naming the file
after the agent**. Which directory that is depends on the layout:

```bash
# Standard OpenCode layout, one file per agent:
cp agent/streamer.md ~/.config/opencode/agents/streamer.md

# A custom agents root (OPENCODE_CONFIG / a directory of folders per agent):
cp agent/streamer.md ~/.agents/agents/streamer/agent.md
```

Either shape works; what matters is that the agent ends up named `streamer`,
matching `streamer.agent` in the daemon's config. OpenCode also loads the
global `AGENTS.md` and the project's into every agent, the streamer included —
keep global rules about *how to do work* scoped, so they do not confuse a
subagent whose only job is to speak.

**Verify** end to end: open a session, click the waveform button, say something
short. The transcript strip should show what was heard. Then:

```bash
journalctl --user -u opencode-web-stream -f -o cat | jq -c '{scope, msg}'
```

A working voice turn logs `live on`, `streamer session created`, then
`streamer decided`.

### 10.6 When something misbehaves

| Symptom | Likely cause | Check |
| --- | --- | --- |
| The tab freezes on load | An old bundle is being served | `systemctl --user restart opencode-lens` after every build |
| No button in the composer | The plugin is not registered, or Lens was not restarted | `OPENCODE_WEB_PLUGINS` points at `lens.plugin.json`, then restart Lens |
| The button is greyed out | The daemon is unreachable from the browser | `curl …/__stream__/health` through the proxy, not just on localhost |
| "Je ne sais pas dans quel dossier travailler" | The page has no workspace in its URL | Open a project first; the new-session page carries the directory, the bare root does not |
| Nothing is spoken, no errors | The streamer agent is not installed under that name | `streamer` must exist as an agent; the daemon logs `streamer request failed` otherwise |
| A robotic browser voice instead of the local one | The daemon cannot reach the TTS endpoint | `/api/status` shows `tts.engine: "browser"` |
| Words are transcribed but never acted on | The streamer answered off-format | `journalctl … \| jq 'select(.msg=="streamer decided")'` shows what it returned |
| Everything works, then goes silent | Live was toggled off, or the session changed | `/api/status` lists the live sessions |
