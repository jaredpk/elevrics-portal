#!/usr/bin/env bash
#
# Guided setup for the portal's four auth secrets.
#
# WHY THIS EXISTS. `wrangler secret put` takes the NAME as an argument and the
# VALUE at a prompt. Paste a value into the argument slot and Wrangler cheerfully
# creates a secret named `sk_live_...` — printing your API key to the terminal,
# your shell history, and anywhere that output gets shared. It is a one-character
# difference in what you do and an enormous difference in what happens, and
# nothing about the command's output tells you which one you got.
#
# So this script never lets a secret be an argument. The two values that must
# come from WorkOS are read from a prompt (the API key silently). The two that
# are just random bytes are generated here and piped straight to Wrangler —
# never displayed, never in your history, never in a scrollback you might paste
# somewhere.
#
# Safe to re-run. Re-running rotates the two generated secrets, which signs out
# any existing portal sessions and nothing else.

set -euo pipefail

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; off=$'\033[0m'

step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$off" "$1"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$off" "$1"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$red" "$1" "$off" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

step "Checking where we are"

[ -f wrangler.jsonc ] || die "Run this from the repo root (no wrangler.jsonc here).
    cd into your elevrics-portal clone and try again."
command -v node >/dev/null || die "node not found on PATH."
ok "in the repo, node $(node --version)"

printf '\n  Wrangler may open a browser to authorise against Cloudflare.\n'
printf '  %sReading the current secrets…%s\n' "$dim" "$off"

existing="$(npx --yes wrangler secret list 2>/dev/null || true)"
[ -n "$existing" ] || die "Couldn't read the Worker's secrets.
    Check that 'npx wrangler whoami' works and that this repo points at the
    right Worker."

# ---------------------------------------------------------------- junk check
#
# A secret whose NAME looks like a VALUE is the failure described at the top.
# Catch it here rather than letting it sit there looking like a real binding.

step "Looking for secrets that were created by mistake"

junk="$(printf '%s' "$existing" \
  | grep -o '"name": *"[^"]*"' \
  | sed 's/.*"name": *"\(.*\)"/\1/' \
  | grep -Ev '^(WORKOS_CLIENT_ID|WORKOS_API_KEY|SESSION_SECRET|ASSERTION_SIGNING_KEY|ASSERTION_SIGNING_KEY_NEXT|PORTAL_ORIGIN)$' || true)"

if [ -n "$junk" ]; then
  warn "These look like values stored as names:"
  printf '%s\n' "$junk" | sed 's/^/      /'
  printf '\n  Anything here has been printed to a terminal, so treat it as leaked.\n'
  printf '  A WorkOS key (sk_…) must be revoked in the dashboard, not just deleted.\n\n'
  read -r -p "  Delete them now? [y/N] " reply
  if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      npx --yes wrangler secret delete "$name" || warn "couldn't delete one — carry on"
    done <<< "$junk"
    ok "deleted"
  else
    warn "left in place — remember to revoke any sk_… key in WorkOS"
  fi
else
  ok "none found"
fi

# ---------------------------------------------------------------- from WorkOS

step "Two values from the WorkOS dashboard"

cat <<'NOTE'
  https://dashboard.workos.com/  — check the picker at the top says Production.

  Client ID   Overview page, or Applications → your application.
              Starts with "client_".
  API key     Overview page → Quick start → "Create API key".
              Starts with "sk_". Shown once; if you lose it, create another.

NOTE

read -r -p "  Client ID: " client_id
[ -n "$client_id" ] || die "nothing entered."
case "$client_id" in
  client_*) ;;
  sk_*) die "that's the API key, not the client ID — they're asked for separately." ;;
  *) warn "doesn't start with 'client_' — continuing, but check it." ;;
esac

# -s so the key never appears on screen or in a scrollback.
read -rs -p "  API key (hidden, paste and press Enter): " api_key
printf '\n'
[ -n "$api_key" ] || die "nothing entered."
case "$api_key" in
  sk_*) ;;
  client_*) die "that's the client ID, not the API key." ;;
  *) warn "doesn't start with 'sk_' — continuing, but check it." ;;
esac

# ---------------------------------------------------------------- generated
#
# Generated in-process and piped to Wrangler. These are never printed, so there
# is no copy-paste step to get wrong and nothing to leak in a scrollback.

step "Generating the two secrets that aren't looked up anywhere"

session_secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
ok "session key — encrypts your login cookie, known only to the Worker"

assertion_key="$(node -e "
crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  .then(k => crypto.subtle.exportKey('jwk', k.privateKey))
  .then(j => console.log(JSON.stringify({...j, kid: 'portal-1'})))
")"
ok "signing key — proves to each module that a request came from the portal"

# ---------------------------------------------------------------- write

step "Storing all four"

put() {
  printf '  %s… ' "$1"
  # printf '%s' rather than echo: no trailing newline to end up inside the value.
  if printf '%s' "$2" | npx --yes wrangler secret put "$1" >/dev/null 2>&1; then
    printf '%s✓%s\n' "$green" "$off"
  else
    printf '%s✗%s\n' "$red" "$off"
    die "failed to store $1 — run 'npx wrangler secret put $1' by hand to see why."
  fi
}

put WORKOS_CLIENT_ID      "$client_id"
put WORKOS_API_KEY        "$api_key"
put SESSION_SECRET        "$session_secret"
put ASSERTION_SIGNING_KEY "$assertion_key"

# ---------------------------------------------------------------- verify

step "Confirming"

final="$(npx --yes wrangler secret list 2>/dev/null || true)"
missing=""
for name in WORKOS_CLIENT_ID WORKOS_API_KEY SESSION_SECRET ASSERTION_SIGNING_KEY; do
  if printf '%s' "$final" | grep -q "\"$name\""; then
    ok "$name"
  else
    missing="$missing $name"
  fi
done

[ -z "$missing" ] || die "still missing:$missing"

cat <<'NEXT'

  All four are set. A deploy takes a moment to pick them up.

  These are not optional. WorkOS is the only login — Cloudflare Access is
  gone — so a deploy missing any of the first three answers 503 on every
  page and names the one it is missing. It fails closed rather than open,
  which is the right way round, but it does mean nobody gets in until all
  four are present.

  Check it from a browser:

    1. Open  https://portal.elevrics.ai/
       You should be sent straight to a WorkOS sign-in screen.

    2. Sign in (or create the account, if this is the first time).
       You should land back on the page you asked for, not on "/".

    3. The bottom of the left rail should show your email and a sign-out
       button.

  And from a terminal, which now sees the same thing a browser does:

    curl -sI https://portal.elevrics.ai/ | head -1     # 302 to /auth/login

NEXT
