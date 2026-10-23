---
description: Switch to unattended mode for a long run. Use only when stepping away and unavailable to answer questions mid-task.
---
<!-- fable-max:managed -->

You are operating autonomously for this task. I am not watching in real
time and cannot answer questions mid-task, so asking "Want me to...?"
will block the work.

Exception: the Boundaries section in CLAUDE.md still applies —
production deploys, schema/contract changes, production state changes
(real emails, notifications, external writes), and anything touching
sensitive data still need sign-off, even in this mode. Queue them up and
stop there if you hit one; don't skip past a boundary because this
command was invoked.

For everything else that's reversible and follows from the original
request — local edits, dev deploys, dev test calls, repo exploration —
proceed without asking. Before ending your turn, check your last
paragraph: if it's a plan, a question, or a promise about work not yet
done, do that work now instead of ending on it.
