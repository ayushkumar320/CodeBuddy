#!/usr/bin/env bash
#
# Inspect (and optionally prune) local branches already merged into the default
# branch. Dry-run by default: it only *lists* candidates and never deletes
# anything unless you pass --yes. It never touches the default branch or the
# branch you are currently on, and it never deletes remote branches.
#
# Usage:
#   scripts/prune-merged-branches.sh            # list merged branches (dry run)
#   scripts/prune-merged-branches.sh --yes      # delete the listed local branches
#   scripts/prune-merged-branches.sh --base X   # compare against base branch X

set -euo pipefail

cd "$(dirname "$0")/.."

BASE="main"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) APPLY=1 ;;
    --base) shift; BASE="${1:?--base needs a branch name}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

current="$(git rev-parse --abbrev-ref HEAD)"

# Local branches fully merged into BASE, excluding BASE itself and HEAD.
# Kept portable (no mapfile) so it runs on the bash 3.2 shipped with macOS.
merged="$(
  git branch --merged "$BASE" --format='%(refname:short)' \
    | grep -vxE "$BASE|$current" || true
)"

if [ -z "$merged" ]; then
  echo "No local branches are merged into '$BASE' (nothing to prune)."
  exit 0
fi

count="$(printf '%s\n' "$merged" | wc -l | tr -d ' ')"

echo "Local branches merged into '$BASE':"
printf '  %s\n' $merged

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry run — nothing deleted. Re-run with --yes to delete these local branches."
  exit 0
fi

echo
for b in $merged; do
  git branch -d "$b"
done
echo "Deleted $count merged local branch(es). Remote branches were not touched."
