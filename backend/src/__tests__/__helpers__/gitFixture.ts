/**
 * Shared fixture helpers for tests that need a real local git repository
 * served over smart HTTPS. Two tests in this directory build the same shape
 * of bare repo (init source, write compose, commit, bare-clone) for their own
 * TLS servers; this helper keeps that logic in one place.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

export interface BuildBareRepoOptions {
    /** Tmpdir prefix for the working source repo. */
    srcPrefix?: string;
    /** Tmpdir prefix for the bare clone. */
    barePrefix?: string;
    /** Git user.email for the fixture commit. */
    userEmail?: string;
    /** Git user.name for the fixture commit. */
    userName?: string;
    /** Branch name; defaults to 'main'. */
    branch?: string;
}

export function buildBareRepo(opts: BuildBareRepoOptions = {}): string {
    const srcPrefix = opts.srcPrefix ?? 'sencho-git-src-';
    const barePrefix = opts.barePrefix ?? 'sencho-git-bare-';
    const userEmail = opts.userEmail ?? 'git-fixture@sencho.test';
    const userName = opts.userName ?? 'Sencho Git Fixture';
    const branch = opts.branch ?? 'main';
    const srcDir = mkdtempSync(path.join(os.tmpdir(), srcPrefix));
    const run = (args: string[], cwd: string, label: string) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${label} failed: ${r.stderr}`);
    };
    run(['init', '-b', branch], srcDir, 'init');
    run(['config', 'user.email', userEmail], srcDir, 'config email');
    run(['config', 'user.name', userName], srcDir, 'config name');
    writeFileSync(path.join(srcDir, 'compose.yaml'), 'services:\n  x:\n    image: nginx\n');
    run(['add', '-A'], srcDir, 'add');
    run(['commit', '-m', 'fixture'], srcDir, 'commit');
    const bareRoot = mkdtempSync(path.join(os.tmpdir(), barePrefix));
    const bareDir = path.join(bareRoot, 'repo.git');
    const clone = spawnSync('git', ['clone', '--bare', '--quiet', srcDir, bareDir], { encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone --bare failed: ${clone.stderr}`);
    return bareDir;
}
