---
"@ai-hero/sandcastle": patch
---

Prove worktree lifecycle safety: destructive cleanup now requires a run-scoped ownership receipt verified against freshly re-read git state (registration, branch, directory, uncommitted-work check) before and after removal. Unknown, stale, or contradictory state fails closed — nothing is mutated and the worktree is preserved for inspection. Cleanup failures no longer mask the primary run failure, and a successful run can no longer be reported while cleanup postconditions are unverified. A read-before-write guard also prevents force-deleting a temp branch whose tip is not an ancestor of the host branch.
