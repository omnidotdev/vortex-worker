---
"@omnidotdev/vortex-worker": patch
---

Enforce MCP server tenancy: a workflow can only use its own organization's MCP servers, tenant servers must use a remote transport (sse or http) that passes the SSRF guard, stdio servers are reserved for the platform org, and only platform-org servers are connected at boot
