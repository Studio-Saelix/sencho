import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import { isDebugEnabled } from '../utils/debug';
import { isPathWithinBase } from '../utils/validation';
import { DatabaseService } from './DatabaseService';

/**
 * Identity recorded against a console session in the audit log. Built by the
 * upgrade handler once the RBAC and tier gates have passed, so every spawned
 * host shell leaves a durable open/close trail (not just an ephemeral log).
 */
export interface ConsoleAuditContext {
    readonly username: string;
    // null marks the local node (matching AuditLogEntry.node_id); the console
    // path always supplies a concrete id.
    readonly nodeId: number | null;
    readonly ipAddress: string;
}

const CONSOLE_AUDIT_PATH = '/api/system/host-console';
// xterm grids never approach these bounds; the cap rejects malformed or
// hostile resize frames before they reach node-pty.
const MAX_TERMINAL_DIMENSION = 1000;

let cachedShell: string | null = null;
function getUnixShell(): string {
    if (cachedShell) return cachedShell;
    try {
        execSync('which bash', { stdio: 'ignore' });
        cachedShell = 'bash';
    } catch (e) {
        console.warn('[HostTerminalService] bash not found, falling back to sh:', (e as Error).message);
        cachedShell = 'sh';
    }
    return cachedShell;
}

// Pattern-based filtering: block any env var whose name contains sensitive keywords.
// Broad matching is intentional; false positives (stripping a benign var like COLORTERM)
// are safer than false negatives (leaking a secret through printenv).
const SENSITIVE_PATTERNS = /SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|PASSPHRASE|ENCRYPT|SIGNING/i;

// Explicit set catches well-known connection strings that may not match the pattern.
const SENSITIVE_KEYS = new Set(['DATABASE_URL', 'REDIS_URL', 'MONGO_URI', 'AMQP_URL', 'DSN']);

const MAX_CONSOLE_SESSIONS = 5;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

// Cached sanitized environment; process.env does not change at runtime.
let cachedSafeEnv: Record<string, string> | null = null;

export class HostTerminalService {
    static activeSessions = new Map<number, { username: string; startedAt: number }>();

    /**
     * Sanitize a set of environment variables by removing entries whose names
     * match sensitive patterns or are in the explicit blocklist.
     */
    static sanitizeEnv(env: Record<string, string>): Record<string, string> {
        return Object.fromEntries(
            Object.entries(env).filter(
                ([k]) => !SENSITIVE_PATTERNS.test(k) && !SENSITIVE_KEYS.has(k)
            )
        );
    }

    /**
     * Resolve the working directory for a console session. With no stack the
     * session opens at the base directory. With a stack, the resolved path must
     * be the base itself or sit strictly below it: a bare prefix match would let
     * a sibling like `<base>-evil` (reached via `../<base>-evil`) escape, so the
     * canonical path-boundary check is used. Returns null when the stack escapes.
     */
    static resolveConsoleDirectory(baseDir: string, stackParam: string | null): string | null {
        const resolvedBase = path.resolve(baseDir);
        if (!stackParam) return resolvedBase;
        const resolved = path.resolve(resolvedBase, stackParam);
        return isPathWithinBase(resolved, resolvedBase) ? resolved : null;
    }

    /**
     * Record a console session lifecycle event in the audit log. Failures here
     * must never tear down a live shell, so the write is best-effort.
     */
    private static recordAudit(audit: ConsoleAuditContext, statusCode: number, summary: string): void {
        try {
            DatabaseService.getInstance().insertAuditLog({
                timestamp: Date.now(),
                username: audit.username,
                method: 'WS',
                path: CONSOLE_AUDIT_PATH,
                status_code: statusCode,
                node_id: audit.nodeId,
                ip_address: audit.ipAddress,
                summary,
            });
        } catch (err) {
            console.error('[HostConsole] Failed to write session audit log:', err);
        }
    }

    static spawnTerminal(ws: WebSocket, targetDirectory: string, audit: ConsoleAuditContext) {
        const { username } = audit;
        // Enforce concurrent session limit
        if (HostTerminalService.activeSessions.size >= MAX_CONSOLE_SESSIONS) {
            console.warn('[HostConsole] Session rejected: max concurrent sessions reached', {
                current: HostTerminalService.activeSessions.size,
                max: MAX_CONSOLE_SESSIONS,
                user: username,
            });
            ws.send('Error: Maximum console sessions reached. Close an existing session and try again.\r\n');
            ws.close();
            return;
        }

        const shell = os.platform() === 'win32' ? 'powershell.exe' : getUnixShell();
        if (!cachedSafeEnv) {
            cachedSafeEnv = HostTerminalService.sanitizeEnv(process.env as Record<string, string>);
        }
        const startedAt = Date.now();

        let ptyProcess: pty.IPty;
        try {
            ptyProcess = pty.spawn(shell, [], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: targetDirectory,
                env: cachedSafeEnv,
            });
        } catch (e) {
            const msg = (e as Error).message || '';
            console.error('[HostConsole] Failed to spawn PTY', { user: username, directory: targetDirectory, error: msg });
            if (/ENOENT|not found/i.test(msg)) {
                ws.send('Error: Shell not found on this system. Ensure bash or sh is installed.\r\n');
            } else if (/EACCES|permission/i.test(msg)) {
                ws.send('Error: Permission denied when spawning shell process.\r\n');
            } else {
                ws.send('Error: Failed to start terminal session.\r\n');
            }
            ws.close();
            return;
        }

        const pid = ptyProcess.pid;
        HostTerminalService.activeSessions.set(pid, { username, startedAt });
        console.log('[HostConsole] Session opened', { user: username, directory: targetDirectory, shell, pid });
        HostTerminalService.recordAudit(audit, 101, 'Opened host console session');
        if (isDebugEnabled()) console.debug('[HostConsole:diag] Session-open audit recorded', { user: username, node: audit.nodeId, pid });

        // Guard against duplicate cleanup when both WS close and PTY exit fire
        let cleaned = false;
        const cleanup = (source: string, extra?: Record<string, unknown>) => {
            if (cleaned) return;
            cleaned = true;
            clearInterval(pingInterval);
            HostTerminalService.activeSessions.delete(pid);
            const durationMs = Date.now() - startedAt;
            console.log(`[HostConsole] Session closed (${source})`, { user: username, pid, durationMs, ...extra });
            HostTerminalService.recordAudit(audit, 200, `Closed host console session (${durationMs}ms)`);
        };

        // Heartbeat: detect dead connections and clean up orphaned PTY processes
        let lastPong = Date.now();
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
                if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
                    console.warn('[HostConsole] Heartbeat timeout, terminating session', { user: username, pid });
                    clearInterval(pingInterval);
                    ws.terminate();
                    ptyProcess.kill();
                }
            }
        }, PING_INTERVAL_MS);
        ws.on('pong', () => { lastPong = Date.now(); });

        ptyProcess.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data); // Raw-Down protocol
            }
        });

        ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
            try {
                const parsed = JSON.parse(raw.toString()); // JSON-Up protocol
                if (parsed.type === 'input') {
                    ptyProcess.write(parsed.payload);
                } else if (parsed.type === 'resize') {
                    const { cols, rows } = parsed;
                    if (
                        Number.isInteger(cols) && Number.isInteger(rows) &&
                        cols > 0 && rows > 0 &&
                        cols <= MAX_TERMINAL_DIMENSION && rows <= MAX_TERMINAL_DIMENSION
                    ) {
                        ptyProcess.resize(cols, rows);
                        if (isDebugEnabled()) console.debug('[HostConsole:diag] Terminal resized', { cols, rows, pid });
                    } else if (isDebugEnabled()) {
                        console.debug('[HostConsole:diag] Ignored invalid resize frame', { cols, rows, pid });
                    }
                }
            } catch (e) {
                console.error('[HostConsole] Failed to parse terminal message:', { pid, error: (e as Error).message });
            }
        });

        ws.on('close', () => {
            cleanup('WS');
            ptyProcess.kill();
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
            cleanup('PTY exit', { exitCode, signal });
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
    }
}
