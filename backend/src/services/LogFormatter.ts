export class LogFormatter {
    // ANSI Color Codes
    private static readonly GRAY = '\x1b[90m';
    private static readonly CYAN = '\x1b[36m';
    private static readonly RED = '\x1b[31m';
    private static readonly YELLOW = '\x1b[33m';
    private static readonly BLUE = '\x1b[34m';
    private static readonly WHITE = '\x1b[37m';
    private static readonly RESET = '\x1b[0m';

    // Regex patterns
    // Matches standard ISO timestamps like "2024-02-26T12:34:56.789Z " or "2024-02-26 12:34:56 " at the start
    private static readonly TIMESTAMP_REGEX = /^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s*)/;

    // Matches docker-compose style prefix like "container-name  | " or "db-1 | "
    private static readonly PREFIX_REGEX = /^([a-zA-Z0-9_.-]+)(?:\s+\|\s+)/;

    // Level regexes (case insensitive for matching, but we check raw string for precise targeting if needed)
    private static readonly ERROR_REGEX = /\b(ERROR|ERR|Exception|Fatal)\b/i;
    private static readonly WARN_REGEX = /\b(WARN|WRN)\b/i;
    private static readonly INFO_REGEX = /\b(INFO|INF)\b/i;

    public static process(line: string): string {
        if (!line || line.trim() === '') return line;

        let processedLine = line;
        let formatAccumulator = '';

        // 1. Process at most one container-name prefix and one Docker
        // timestamp in arrival order. Each regex is anchored at ^ and
        // strips its match from the remainder. The prefixFound /
        // timestampFound guards prevent false matches on legitimate
        // log bodies that happen to contain "word | " later in the line.
        let changed = true;
        let prefixFound = false;
        let timestampFound = false;
        while (changed) {
            changed = false;

            if (!prefixFound) {
                const prefixMatch = processedLine.match(LogFormatter.PREFIX_REGEX);
                if (prefixMatch) {
                    const pfxMatchStr = prefixMatch[0]; // e.g. "redis | "
                    const name = prefixMatch[1];
                    const restOfPrefix = pfxMatchStr.slice(name.length); // e.g. " | "
                    formatAccumulator += `${LogFormatter.CYAN}${name}${LogFormatter.WHITE}${LogFormatter.RESET}${restOfPrefix}`;
                    processedLine = processedLine.slice(pfxMatchStr.length);
                    changed = true;
                    prefixFound = true;
                }
            }

            if (!timestampFound) {
                const tsMatch = processedLine.match(LogFormatter.TIMESTAMP_REGEX);
                if (tsMatch) {
                    const ts = tsMatch[1];
                    formatAccumulator += `${LogFormatter.GRAY}${ts}${LogFormatter.RESET}`;
                    processedLine = processedLine.slice(ts.length);
                    changed = true;
                    timestampFound = true;
                }
            }
        }

        // 2. Process Levels & JSON
        const trimmedLine = processedLine.trim();

        // Fast JSON Check (Starts with { and ends with })
        if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
            try {
                JSON.parse(trimmedLine);
                // If valid, lightly highlight it (e.g., colorize string representation slightly)
                // We re-stringify it to ensure it's on one line, but maybe just highlight properties
                processedLine = LogFormatter.highlightJson(trimmedLine);
            } catch (e) {
                // Not valid JSON, fall through to level checking
                processedLine = LogFormatter.highlightLevels(processedLine);
            }
        } else {
            // 4. Highlight Levels (Error, Warn, etc.)
            processedLine = LogFormatter.highlightLevels(processedLine);
        }

        return formatAccumulator + processedLine;
    }

    private static highlightLevels(text: string): string {
        if (LogFormatter.ERROR_REGEX.test(text)) {
            return `${LogFormatter.RED}${text}${LogFormatter.RESET}`;
        }
        if (LogFormatter.WARN_REGEX.test(text)) {
            return `${LogFormatter.YELLOW}${text}${LogFormatter.RESET}`;
        }
        // For INFO, we can leave as default, or we can make the whole line a bit brighter, but let's leave default to avoid washing out the terminal
        return text;
    }

    private static highlightJson(jsonStr: string): string {
        // A simple regex to highlight JSON keys in blue
        // Matches "key":
        const keyRegex = /"([^"]+)":/g;
        return jsonStr.replace(keyRegex, `${LogFormatter.BLUE}"$1"${LogFormatter.RESET}:`);
    }
}
