// Matches a value a spreadsheet would evaluate as a formula: a metacharacter
// (= + - @), optionally preceded by whitespace, since Excel / Sheets /
// LibreOffice ignore leading blanks when detecting formulas. A leading tab or
// carriage return is also treated as a trigger because some parsers strip it
// before evaluating what follows. Audit summaries embed user-controlled
// resource names, so any field can reach the export untrusted.
const FORMULA_LEAD_RE = /^\s*[=+\-@]/;

function startsFormula(str: string): boolean {
  return str[0] === '\t' || str[0] === '\r' || FORMULA_LEAD_RE.test(str);
}

/**
 * Escape a single field for RFC 4180 CSV output. Neutralizes formula injection
 * by prefixing a single quote when the value would be read as a formula
 * (CWE-1236), then wraps the value in quotes and doubles embedded quotes when
 * it contains a comma, quote, or line break. Null / undefined become the empty
 * string.
 */
export function escapeCsvField(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  if (str.length > 0 && startsFormula(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
