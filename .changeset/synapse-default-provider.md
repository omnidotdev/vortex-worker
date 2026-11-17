---
"@omnidotdev/vortex-worker": minor
---

Agent and model registry steps now run through Synapse, the Omni AI gateway, by default. A step that names no provider uses the `auto` model and the Synapse key connected in your workspace integrations. Steps that name a provider such as OpenAI or Anthropic keep calling it with that provider's key, now looked up from your workspace integrations when the step does not pass one. A Synapse key is never sent to any other host, and a stored key is never sent to a custom endpoint.
