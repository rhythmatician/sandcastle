---
"@ai-hero/sandcastle": patch
---

Make host worktree creation and pruning timeouts configurable through `timeouts.worktreeMs`, raise the default to 120 seconds, and terminate Git subprocesses when lifecycle operations time out.
