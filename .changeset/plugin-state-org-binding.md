---
"@omnidotdev/vortex-worker": patch
---

Bind WASM plugin state (`vortex_state_get` / `vortex_state_set`) to the executing workflow's organization; a plugin can no longer read or write another organization's state by naming its org id
