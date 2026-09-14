# KπX Sovereign Web Stream Architecture

This document defines the philosophy, architecture, and behavioral rules of the new unified `opencode-web-stream` plugin.

## 1. Philosophy: Semantic Intelligence vs. Heuristics
The legacy system relied on a passive narrator and hardcoded heuristics (e.g., `SILENT_TOOLS` arrays). This was an architectural flaw. 
**The new philosophy demands ZERO heuristics.** 
The central sub-agent (the `streamer`) uses its semantic intelligence to intelligently decide what to say, when to say it, and whether to interact with the user or the main worker agent.

## 2. The Central Role of the "Streamer"
The `streamer` is no longer a simple progress reader. It becomes the **intelligent, central gateway** of the entire Web Stream interface. It holds the core `~/.agents/AGENTS.md` in its context, alongside a phonetic index of the project's keywords.

Its core responsibilities are:
1. **Voice Interception (STT):** Any spoken word from KπX is routed *first* to the streamer.
   - *Noise/Hesitation:* It decides to ignore it (`<IGNORE>`).
   - *Simple Question (Known Context):* It answers directly out loud, without waking the main worker agent (`<DIRECT>`).
   - *Complex Order (Barge-in / New Prompt):* It cleans the transcription (fixing typos, adjusting terms via the phonetic index), reformulates the order to the strict minimum, and injects it into the main agent's queue while vocally acknowledging: "Je modifie l'approche pour..." (`<INJECT>`).
2. **Keyboard Interception:** Anything KπX types on the keyboard is silently injected into the streamer's context. It takes note without speaking.
3. **Continuous Narration:** It explains *what it is doing* and *why* in the present tense.

## 3. Tool Management: Semantic Batching
The plugin code no longer triggers an LLM call for every single tool. It **batches** tools by logical categories until a context shift occurs, then sends the batch to the streamer.

**Tool Groups:**
- `EXPLORE`: `read`, `ast`, `glob`
- `PATCH`: `edit`
- `SEARCH`: `exa_web_search_exa`, `exa_web_fetch_exa`
- `SHELL`: `bash`

*Mechanics:* If the main agent fires 4 `read` commands in a row, the plugin accumulates them. As soon as a `bash` command or the end of the turn arrives, the batch of 4 `read` commands is sent to the streamer.

## 4. Streamer Control Tokens
When faced with a tool batch, the streamer must use its semantic intelligence and respond using strict control tokens:
- `<SILENT>`: If the action is trivial (e.g., a mundane `ls`, a minor read). The streamer chooses to remain silent. The plugin continues to batch subsequent steps.
- `<SPEAK> My text...`: The streamer decides there is enough substance to inform KπX. It explains the action **in the present tense** and provides the **why** ("J'explore le dossier src pour identifier la source du crash...").
- `<INJECT> Corrected text...`: In response to an STT prompt, the streamer reformulates and asks the plugin to inject the command to the main agent.
- `<DIRECT> My answer...`: In response to a simple STT prompt, the streamer answers directly to KπX without disturbing the main agent.

## 5. Vocal Narration Rules
1. **Always in the Present Tense:** The streamer speaks about the current action in the present tense ("Je patche le fichier...", "Je fais des recherches sur..."), never in the past ("J'ai lu..."), even if it receives the information right after execution. It acts as if it is actively doing it.
2. **The "Why" over the "What":** Never list read files mechanically. Explain the intent behind the tool batch.
3. **WRAP_UP goes straight to the point:** During the final summary, **absolute prohibition** to recall what was already done ("J'ai d'abord fait ci, puis ça"). The streamer delivers the raw final answer fluidly and concisely, because KπX has already listened to the live progression.

## 6. Persistence
The streamer is instantiated *once* as soon as the "Live" streaming button is activated. It runs continuously in the background and maintains its context history, even if the Web session is refreshed, guaranteeing an uninterrupted memory of the exchange.