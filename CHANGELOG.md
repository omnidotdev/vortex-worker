# @omnidotdev/vortex-worker

## 0.1.0

### Minor Changes

- [#70](https://github.com/omnidotdev/vortex-worker/pull/70) [`8ae69bf`](https://github.com/omnidotdev/vortex-worker/commit/8ae69bf9e26e1cfa7c664bb5adebccdc0a47c950) Thanks [@coopbri](https://github.com/coopbri)! - Agent and model registry steps now run through Synapse, the Omni AI gateway, by default. A step that names no provider uses the `auto` model and the Synapse key connected in your workspace integrations. Steps that name a provider such as OpenAI or Anthropic keep calling it with that provider's key, now looked up from your workspace integrations when the step does not pass one. A Synapse key is never sent to any other host, and a stored key is never sent to a custom endpoint.

### Patch Changes

- [#71](https://github.com/omnidotdev/vortex-worker/pull/71) [`0a133ea`](https://github.com/omnidotdev/vortex-worker/commit/0a133ea03a7832bd8549ffb46eaa6de1381d4d1a) Thanks [@coopbri](https://github.com/coopbri)! - AI Agent nodes added from the workflow editor now run instead of failing with an unknown action.

- [#67](https://github.com/omnidotdev/vortex-worker/pull/67) [`6f3b037`](https://github.com/omnidotdev/vortex-worker/commit/6f3b0374036d4ddddcb6892ec1cc7c752947151a) Thanks [@coopbri](https://github.com/coopbri)! - Tightened workspace isolation for MCP servers: workflows only use their own workspace's servers, over remote transports.

- [#68](https://github.com/omnidotdev/vortex-worker/pull/68) [`0a2a687`](https://github.com/omnidotdev/vortex-worker/commit/0a2a687aa729de701ff976632e5ee1c3837f85c0) Thanks [@coopbri](https://github.com/coopbri)! - Tightened workspace isolation for plugin data.

- [#72](https://github.com/omnidotdev/vortex-worker/pull/72) [`ff3158f`](https://github.com/omnidotdev/vortex-worker/commit/ff3158f8c7de7951524622440dbd720242d43e1c) Thanks [@coopbri](https://github.com/coopbri)! - Stop writing email addresses to the logs. Email sends from the built-in email action now log only the recipient count and message id, by moving to `@omnidotdev/providers` v0.2.0. The same upgrade forwards cc, bcc, and reply-to to Herald, keeps the sender display name, and retries a send once or twice when Herald is briefly unavailable.

- [#66](https://github.com/omnidotdev/vortex-worker/pull/66) [`f055ad3`](https://github.com/omnidotdev/vortex-worker/commit/f055ad37dc1da2b3ae9b07d392eb8d5fefa8892d) Thanks [@coopbri](https://github.com/coopbri)! - Tightened what workflow templates can access, so templates can no longer read server settings.
