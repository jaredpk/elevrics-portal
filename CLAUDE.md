# repo

<!-- BEGIN FABLE-MAX (managed by sync-fable-max.sh — do not edit inside) -->
## Orchestration (Claude Kit)
Act as orchestrator. Delegate independent subtasks to the subagents below
and keep working while they run — don't block on one before starting the
next unless the second genuinely depends on the first's output.

Subagents (.claude/agents/):
- `scout` (haiku) — read-only exploration. "Where does X live," "what
  references this function / config / env var," "what changed recently."
- `builder` (inherits your selected model) — makes the edits: code,
  scripts, templates, config.
- `verifier` (inherits your selected model, fresh context) — exercises
  the change against a local run or a test/staging environment and
  checks it against spec. Always run after builder finishes, in a fresh
  context.
- `oracle` (fable, xhigh, fresh context) — escalation only: cross-system
  contract/schema design, root-causing a bug that survived a
  builder/verifier round, anything genuinely hard. Returns an analysis
  or a precise plan; never edits — builder implements what it returns.

Rules:
- Escalate to oracle sparingly — only for problems that already beat the
  normal loop. Package its brief carefully: the constraint, the relevant
  files, what was tried, what "correct" looks like.
- Don't swap the session's main model mid-task — scale up via oracle
  instead; model swaps invalidate the prompt cache.
- Announce each delegation in one line: which agent, which model, what
  task.

## Effort
Default: high. Drop to medium for routine tweaks. xhigh lives in oracle —
escalate the hard subtask there instead of raising the whole session.

## Boundaries — pause and ask before proceeding
- Any deploy or config change to this project's production target (e.g.
  `fly deploy`, `fly secrets set`, or any equivalent for wherever this
  project actually runs live). Local/dev/staging is fine.
- Publishing anything publicly that isn't already public (repo visibility,
  releases, domains, packages).
- Any action that spends real money: calls against billed/metered APIs,
  upgrading a paid tier, provisioning new paid infrastructure.
- Deleting or overwriting data that isn't trivially reproducible
  (production database rows, user uploads, git history).
- Sending real outbound communications (emails, notifications, webhooks)
  to real recipients rather than test addresses/sandboxes.
- Changing a public-facing API/response shape or CLI interface that
  something else might already depend on.

Show the plan, wait for approval, then execute. Everything else that's
local, dev-scoped, or read-only can proceed without checking in first.

## Verification
After any builder change, run verifier before reporting done. Verifier
targets local runs or dev/test environments — never production. Don't
report "should work now" without evidence from this session to point to.
If something failed or wasn't checked, say so plainly.

<!-- Add a short "Project specifics" note above this block in each
target repo's own CLAUDE.md, naming that repo's actual production
target — e.g. "Production = opportunities.elevrics.ai via `fly deploy`
from this repo." That note stays outside the markers so this sync
script never touches it. -->
<!-- END FABLE-MAX -->
