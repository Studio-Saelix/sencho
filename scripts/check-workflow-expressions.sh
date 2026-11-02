#!/usr/bin/env bash
# Fail when a workflow holds an expression GitHub Actions will not evaluate.
# Actions only evaluates ${{ ... }}. A single-brace form such as ${ steps.x.outputs.y } is passed
# through as literal text (here it was baked into an image build arg), and actionlint accepts it.
# Usage: scripts/check-workflow-expressions.sh [path ...]   (default: .github)
# Prints file:line for each hit and exits 1 when there is one.
set -euo pipefail
[ $# -gt 0 ] || set -- .github
CTX='steps|inputs|github|env|needs|matrix|secrets|vars|runner|job|strategy'
FN='hashFiles|success|failure|always|cancelled|format|contains|startsWith|endsWith|fromJSON|toJSON|join'
fail=0

# A path that does not exist would make both checks pass on nothing.
for p in "$@"; do
  [ -e "$p" ] || { echo "check-workflow-expressions: no such path: $p" >&2; exit 2; }
done

# 1. A single-brace expression, a "$ {" split, or a run of four braces (templated text that was mangled).
if grep -rnHE --include='*.yml' --include='*.yaml' \
  "(^|[^\$])\\\$\\{ *(($CTX)\\.|($FN)\\()|\\\$ \\{\\{? *(($CTX)\\.|($FN)\\()|\\{\\{\\{\\{|\\}\\}\\}\\}" "$@"; then
  echo "^ single-brace or malformed workflow expression: write \${{ ... }}" >&2
  fail=1
fi

# 2. In a build-args block, every line that reads a step output or an input must use \${{ .
while IFS= read -r f; do
  awk -v f="$f" '
    { sub(/\r$/, "") }
    function flag(line) { printf "%s:%d: build-arg reads steps. or inputs. without ${{ }}: %s\n", f, NR, line; bad = 1 }
    /^[ \t-]*"?build-args"?:/ {
      inblock = 1; ind = match($0, /[^ \t-]/)
      # a value on the key line itself: a block scalar header ends the line, anything else is the value
      v = $0; sub(/^[ \t-]*"?build-args"?:[ \t]*/, "", v); sub(/[ \t]+#.*$/, "", v)
      if (v !~ /^[|>][+-]?[0-9]*$/ && v ~ /(steps|inputs)\./ && v !~ /\$\{\{/) flag($0)
      next
    }
    inblock {
      if ($0 ~ /^[ \t]*$/) next
      if (match($0, /[^ \t]/) <= ind) { inblock = 0; next }
      if ($0 ~ /(steps|inputs)\./ && $0 !~ /\$\{\{/) flag($0)
    }
    END { exit bad }' "$f" >&2 || fail=1
done < <(grep -rlE --include='*.yml' --include='*.yaml' 'build-args"?:' "$@" || true)

exit "$fail"
