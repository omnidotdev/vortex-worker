---
"@omnidotdev/vortex-worker": patch
---

Stop writing email addresses to the logs. Email sends from the built-in email action now log only the recipient count and message id, by moving to `@omnidotdev/providers` v0.2.0. The same upgrade forwards cc, bcc, and reply-to to Herald, keeps the sender display name, and retries a send once or twice when Herald is briefly unavailable.
