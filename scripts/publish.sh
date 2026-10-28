#!/usr/bin/env bash
# Commit the given data files and push to main, retrying if another job pushed first.
set -euo pipefail
label="$1"; shift
git config user.name "northline-bot"
git config user.email "northline-bot@users.noreply.github.com"
git add -A -- "$@"
if git diff --cached --quiet; then echo "No changes"; exit 0; fi
git commit -q -m "$label $(TZ=America/Toronto date '+%Y-%m-%d %H:%M') (feeds, no AI)"
for i in 1 2 3; do
  if git pull -q --rebase -X theirs origin main && git push -q origin HEAD:main; then
    echo "Pushed $(git rev-parse --short HEAD)"
    if [ -n "${VERCEL_DEPLOY_HOOK_URL:-}" ]; then curl -fsS -X POST "$VERCEL_DEPLOY_HOOK_URL" >/dev/null && echo "Vercel deploy hook called"; fi
    exit 0
  fi
  sleep $((i * 5))
done
echo "Push failed" >&2; exit 1
