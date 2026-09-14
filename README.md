# opencode-web-stream

Sovereign OpenCode Web Stream extension & disk indexer daemon:
- **Frontend Plugin**: Lens plugin for OpenCode Web adding a Gemini Live-style animated soundwaves button, translucent silver Live Stream Overlay, real-time agent execution summaries, barge-in voice redirection, and concise speech updates.
- **Daemon (`daemon/`)**:
  - `indexer.py`: Plocate-fast incremental scanner indexing `~/KpihX-Labs` and `~/.agents` into SQLite `~/.local/share/opencode-web-stream/stream_index.db` with FTS5, Double Metaphone, and Soundex. Auto-tracks additions, modifications, renames, and deletions.
  - `resolver.py`: Phonetic resolver converting misheard speech (`dex proxy` -> `desk-proxy`, `katia xab` -> `KpihX-Labs`).
  - `server.py`: FastAPI & WebSocket streaming server for real-time progress broadcasts, voice streaming, and trajectory redirection.

## Tests
- Python tests: `uv run --directory daemon --extra test pytest -v`
- Web plugin tests: `node --test tests/plugin.test.mjs`
