#!/usr/bin/env bash
# Fail when a workflow holds an expression GitHub Actions will not evaluate.
# Actions only evaluates ${{ ... }}. A single-brace form such as ${ steps.x.outputs.y } is passed
# through as literal text (here it was baked into an image build arg), and actionlint accepts it.
# Usage: scripts/check-workflow-expressions.sh [path ...]   (default: .github)
# Prints file:line for each hit and exits 1 when there is one.
set -euo pipefail
[ $# -gt 0 ] || set -- .github
CTX='steps|inputs|github|env|needs|matrix|secrets|vars|runner|job|jobs|strategy'
# What a step output or an input looks like in an expression: steps.md, or the inputs.example.com of a URL, is not one.
REF='(^|[^A-Za-z0-9_./-])(steps\.[A-Za-z0-9_-]+\.(outputs|outcome|conclusion)|inputs\.[A-Za-z_][A-Za-z0-9_-]*)'
FN='hashFiles|success|failure|always|cancelled|format|contains|startsWith|endsWith|fromJSON|toJSON|join'
fail=0

# A path that does not exist would make both checks pass on nothing.
for p in "$@"; do
  [ -e "$p" ] || { echo "check-workflow-expressions: no such path: $p" >&2; exit 2; }
done

# 1. A single-brace expression, a "$ {" split, or a run of four braces (templated text that was mangled).
# A comment line may quote the broken form to explain it. grep exiting 2 is an error (an unreadable file), not "no match".
set +e
hits=$(grep -rnHE --include='*.yml' --include='*.yaml' \
  "(^|[^\$])\\\$\\{[[:space:]]*((($CTX)(\\.|\\[))|($FN)\\()|\\\$[[:space:]]+\\{\\{?[[:space:]]*((($CTX)(\\.|\\[))|($FN)\\()|\\{\\{\\{\\{|\\}\\}\\}\\}" "$@")
rc=$?
set -e
[ "$rc" -le 1 ] || { echo "check-workflow-expressions: grep failed (exit $rc)" >&2; exit 2; }
hits=$(printf '%s\n' "$hits" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "^ single-brace or malformed workflow expression: write \${{ ... }}" >&2
  fail=1
fi

# 2. In a build-args block, every line that reads a step output or an input must use ${{ .
set +e
files=$(grep -rlE --include='*.yml' --include='*.yaml' "build-args[\"']?[[:space:]]*:" "$@")
rc=$?
set -e
[ "$rc" -le 1 ] || { echo "check-workflow-expressions: grep failed (exit $rc)" >&2; exit 2; }
while IFS= read -r f; do
  [ -n "$f" ] || continue
  REF="$REF" awk -v f="$f" '
    { sub(/\r$/, "") }
    function flag(line) { printf "%s:%d: build-arg reads steps. or inputs. without ${{ }}: %s\n", f, NR, line; bad = 1 }
    /^[ \t-]*["\047]?build-args["\047]?[ \t]*:/ {
      inblock = 1; ind = match($0, /[^ \t-]/)
      # a value on the key line itself: a block scalar header ends the line, anything else is the value
      v = $0; sub(/^[ \t-]*["\047]?build-args["\047]?[ \t]*:[ \t]*/, "", v); sub(/[ \t]+#.*$/, "", v)
      if (v !~ /^[|>][+-]?[0-9]*$/ && v ~ ENVIRON["REF"] && v !~ /\$\{\{/) flag($0)
      next
    }
    inblock {
      if ($0 ~ /^[ \t]*$/) next
      if (match($0, /[^ \t]/) <= ind) { inblock = 0; next }
      if ($0 ~ ENVIRON["REF"] && $0 !~ /\$\{\{/) flag($0)
    }
    END { exit bad }' "$f" >&2 || fail=1
done <<< "$files"

exit "$fail"
