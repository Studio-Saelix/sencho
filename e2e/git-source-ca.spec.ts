/**
 * Per-source custom CA bundle: end-to-end through the product boundary.
 *
 * Drives the full chain - API PUT (encrypted at rest) -> API GET (project
 * exposes has_ca_bundle, never the PEM) -> real HTTPS fetch against a
 * locally-served fixture repo -> API PUT with remove_ca_bundle=true ->
 * API GET confirming the stored PEM was cleared.
 *
 * The fixture server signs its certificate with the committed dev/E2E
 * CA, which the backend also trusts via NODE_EXTRA_CA_CERTS in CI. The
 * per-source path is exercised through the full boundary regardless:
 * the source row is encrypted, the GET hides the PEM, the fetch uses
 * the per-source combined bundle, and the explicit revocation flag
 * wipes the stored PEM.
 */
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { loginAs } from './helpers';
import { gitAvailable, buildFixtureRepo, serveRepos } from './gitServer.helper';

const CA_PEM = fs.readFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'git-ca.pem'),
    'utf8',
);

const APP_FILES = {
    'compose.yaml': 'services:\n  x:\n    image: nginx\n',
};

test.describe('Git Sources per-source CA bundle (product boundary)', () => {
    test.skip(!gitAvailable(), 'system git binary is not available');

    let server: { url: string; close: () => void };
    let stackName: string;

    test.beforeAll(async () => {
        server = await serveRepos({
            app: buildFixtureRepo(APP_FILES),
        });
    });

    test.afterAll(() => {
        server?.close();
    });

    test.beforeEach(async () => {
        stackName = `e2e-ca-${Date.now()}`;
    });

    test.afterEach(async ({ page }) => {
        await page.evaluate(async (name) => {
            await fetch(`/api/stacks/${name}/git-source`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
            await fetch(`/api/stacks/${name}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
        }, stackName);
    });

    test('API stores encrypted CA, exposes has_ca_bundle, never returns PEM, and explicit remove clears it', async ({ page }) => {
        await loginAs(page);
        await page.evaluate(async (name) => {
            const res = await fetch('/api/stacks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ stackName: name }),
            });
            if (res.status !== 200) throw new Error(`create stack failed: ${res.status}`);
        }, stackName);

        const repoUrl = `${server.url}/app.git`;

        // Step 1: PUT with a per-source CA bundle.
        const putRes = await page.evaluate(async ({ name, repoUrl, pem }) => {
            const res = await fetch(`/api/stacks/${name}/git-source`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    repo_url: repoUrl,
                    branch: 'main',
                    compose_paths: ['compose.yaml'],
                    auth_type: 'none',
                    ca_bundle: pem,
                    auto_apply_on_webhook: false,
                    auto_deploy_on_apply: false,
                }),
            });
            return { status: res.status, body: await res.json() };
        }, { name: stackName, repoUrl, pem: CA_PEM });
        expect(putRes.status).toBe(200);
        expect(putRes.body.has_ca_bundle).toBe(true);
        // The PEM must not appear anywhere in the PUT response.
        expect(JSON.stringify(putRes.body)).not.toContain('BEGIN CERTIFICATE');

        // Step 2: GET confirms the persisted state and still hides the PEM.
        const getRes = await page.evaluate(async (name) => {
            const res = await fetch(`/api/stacks/${name}/git-source`, { credentials: 'include' });
            return { status: res.status, body: await res.json() };
        }, stackName);
        expect(getRes.status).toBe(200);
        expect(getRes.body.has_ca_bundle).toBe(true);
        expect(JSON.stringify(getRes.body)).not.toContain('BEGIN CERTIFICATE');

        // Step 3: a real fetch against the per-source-CA-configured repo
        // succeeds. This exercises the full product boundary: encrypted row
        // -> decryption -> combined CA file -> real git fetch.
        const pull = await page.evaluate(async (name) => {
            const res = await fetch(`/api/stacks/${name}/git-source/pull`, {
                method: 'POST',
                credentials: 'include',
            });
            return { status: res.status, body: await res.json() };
        }, stackName);
        expect(pull.status, JSON.stringify(pull.body)).toBe(200);
        expect(pull.body.candidateReady).toBe(true);
        expect(pull.body.commitSha).toMatch(/^[0-9a-f]{40}$/);

        // Step 4: explicit revocation. The textarea is left empty, the UI
        // sends remove_ca_bundle: true. The stored CA must be cleared.
        const revokeRes = await page.evaluate(async ({ name, repoUrl }) => {
            const res = await fetch(`/api/stacks/${name}/git-source`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    repo_url: repoUrl,
                    branch: 'main',
                    compose_paths: ['compose.yaml'],
                    auth_type: 'none',
                    remove_ca_bundle: true,
                    auto_apply_on_webhook: false,
                    auto_deploy_on_apply: false,
                }),
            });
            return { status: res.status, body: await res.json() };
        }, { name: stackName, repoUrl });
        expect(revokeRes.status).toBe(200);
        expect(revokeRes.body.has_ca_bundle).toBe(false);

        // Step 5: GET confirms the row no longer carries a CA bundle.
        const afterRes = await page.evaluate(async (name) => {
            const res = await fetch(`/api/stacks/${name}/git-source`, { credentials: 'include' });
            return { status: res.status, body: await res.json() };
        }, stackName);
        expect(afterRes.status).toBe(200);
        expect(afterRes.body.has_ca_bundle).toBe(false);
    });

    test('API rejects a non-PEM ca_bundle with 400', async ({ page }) => {
        await loginAs(page);
        await page.evaluate(async (name) => {
            const res = await fetch('/api/stacks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ stackName: name }),
            });
            if (res.status !== 200) throw new Error(`create stack failed: ${res.status}`);
        }, stackName);

        const repoUrl = `${server.url}/app.git`;
        const reject = await page.evaluate(async ({ name, repoUrl }) => {
            const res = await fetch(`/api/stacks/${name}/git-source`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    repo_url: repoUrl,
                    branch: 'main',
                    compose_paths: ['compose.yaml'],
                    auth_type: 'none',
                    ca_bundle: 'not a certificate at all',
                    auto_apply_on_webhook: false,
                    auto_deploy_on_apply: false,
                }),
            });
            return { status: res.status, body: await res.json() };
        }, { name: stackName, repoUrl });
        expect(reject.status).toBe(400);
        expect(String(reject.body.error || '')).toMatch(/PEM|certificate/i);
    });
});
