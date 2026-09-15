# Lens proxy

`lens-proxy.mjs` is KπX's opencode-lens reverse proxy with the one change this
plugin needs: the stream daemon's address is read from
`OPENCODE_WEB_STREAM_TARGET` (default `http://127.0.0.1:8765`) instead of being
written twice in the file. Nothing else differs from the version already in
service; every other plugin's behaviour is untouched.

Copy it over `opencode-lens/scripts/lens-proxy.mjs` and restart the
`opencode-lens` user service. Add `OPENCODE_WEB_STREAM_TARGET` to the unit only
if the daemon moves off port 8765.
