---
"@omnidotdev/vortex-worker": patch
---

Stop exposing the worker environment to workflow templates. Tenant workflows no longer resolve `{{ env.X }}` at all, and platform-org system workflows see only an explicit whitelist of the keys they need
