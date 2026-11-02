#!/usr/bin/env bash
# Fail when a workflow holds an expression GitHub Actions will not evaluate.
# Actions only evaluates ${{ ... }}. A single-brace form such as ${ steps.x.outputs.y } is passed
# through as literal text (here it was baked into an image build arg), and actionlint accepts it.
# Usage: scripts/check-workflow-expressions.sh [path ...]   (default: .github)
# Prints file:line for each hit and exits 1 when there is one.
set -euo pipefail
[ $# -gt 0 ] || set -- .github
CTX='steps|inputs|github|env|needs|matrix|secrets|vars|runner|job|strategy'
fail=0

# 1. A single-brace expression, a "$ {" split, or a run of four braces (templated text that was mangled).
if grep -rnHE --include='*.yml' --include='*.yaml' \
  "(^|[^\$])\\\$\\{ ?($CTX)\\.|\\\$ \\{\\{? ?($CTX)\\.|\\{\\{\\{\\{|\\}\\}\\}\\}" "$@"; then
  echo "^ single-brace or malformed workflow expression: write \${{ ... }}" >&2
  fail=1
fi

# 2. In a build-args block, every line that reads a step output or an input must use \${{ .
while IFS= read -r f; do
  awk -v f="$f" '
    /^[ \t]*[A-Za-z_-]+:[ \t]*[|>]?[ \t]*$/ { inblock = ($0 ~ /^[ \t]*build-args:/); ind = match($0, /[^ \t]/); next }
    inblock {
      if ($0 ~ /^[ \t]*$/) next
      if (match($0, /[^ \t]/) <= ind) { inblock = 0; next }
      if ($0 ~ /(steps|inputs)\./ && $0 !~ /\$\{\{/) { printf "%s:%d: build-arg reads steps. or inputs. without ${{ }}: %s\n", f, NR, $0; bad = 1 }
    }
    END { exit bad }' "$f" >&2 || fail=1
done < <(grep -rlE --include='*.yml' --include='*.yaml' 'build-args:' "$@" || true)

exit "$fail"
