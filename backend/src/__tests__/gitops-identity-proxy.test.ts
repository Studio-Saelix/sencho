import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import zlib from 'zlib';
import {
  IDENTITY_PROXY_MAX_BYTES,
  handleIdentityResponse,
  isGitOpsHistoryRoute,
  isGitOpsIdentityJsonRoute,
  prepareIdentityQuery,
  rewriteIdentityPayload,
  stripConditionalRequestHeaders,
  filterIdentityCollection,
  filterRemoteIdentityPayload,
  type IdentityResponseSink,
  type IdentityTerminalKind,
} from '../proxy/gitopsIdentityProxy';

describe('gitops identity proxy', () => {
  describe('route matching', () => {
    it('intercepts the identity GETs', () => {
      for (const path of [
        '/git-sources',
        '/git-sources/history',
        '/stacks/web/git-source',
        '/stacks/web/git-source/history',
        '/stacks/web/drift',
      ]) {
        expect(isGitOpsIdentityJsonRoute(path, 'GET')).toBe(true);
      }
    });

    it('intercepts the drift re-check, the one mutation that answers with a revision', () => {
      // The GET beside it is rewritten, and both return the same projection
      // object. Leaving the re-check on the streaming hop would make one object
      // carry the hub's node numbering or the remote's depending only on how it
      // was asked for.
      expect(isGitOpsIdentityJsonRoute('/stacks/web/drift/recheck', 'POST')).toBe(true);
      expect(isGitOpsIdentityJsonRoute('/stacks/web/drift/recheck', 'GET')).toBe(false);
      expect(isGitOpsIdentityJsonRoute('/stacks/web/drift', 'POST')).toBe(false);
    });

    it('leaves streaming and unrelated routes to the streaming hop', () => {
      // Buffering any of these to rewrite identities they do not carry would
      // break streaming or cap a legitimately large response.
      for (const path of [
        '/stacks/web/logs',
        '/containers/abc/logs',
        '/stacks/web/files/download',
        '/git-sources/browse',
        '/stacks/web/git-source/manifest',
        '/blueprints',
      ]) {
        expect(isGitOpsIdentityJsonRoute(path, 'GET')).toBe(false);
      }
    });

    it('never intercepts a mutation of a git-source route', () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect(isGitOpsIdentityJsonRoute('/stacks/web/git-source', method)).toBe(false);
        expect(isGitOpsIdentityJsonRoute('/git-sources', method)).toBe(false);
      }
    });

    it('recognizes only the history pair as history', () => {
      expect(isGitOpsHistoryRoute('/git-sources/history')).toBe(true);
      expect(isGitOpsHistoryRoute('/stacks/web/git-source/history')).toBe(true);
      expect(isGitOpsHistoryRoute('/git-sources')).toBe(false);
      expect(isGitOpsHistoryRoute('/stacks/web/git-source')).toBe(false);
    });
  });

  describe('outbound query', () => {
    const prep = (qs: string, path: string, hubNodeId: number | undefined) =>
      prepareIdentityQuery(new URLSearchParams(qs), path, hubNodeId);

    it('always strips a caller-supplied local-target flag', () => {
      // Only the hub may tell a remote to filter to its own node.
      const result = prep('gitopsLocalTarget=1', '/git-sources', 3);
      if (result.kind !== 'forward') throw new Error('expected forward');
      expect(result.search.get('gitopsLocalTarget')).toBeNull();
    });

    it('strips nodeId on the non-history routes', () => {
      const result = prep('nodeId=3', '/git-sources', 3);
      if (result.kind !== 'forward') throw new Error('expected forward');
      expect(result.search.get('nodeId')).toBeNull();
      expect(result.search.get('gitopsLocalTarget')).toBeNull();
    });

    it('translates a matching node into the local-target flag on history', () => {
      const result = prep('nodeId=3&limit=10', '/git-sources/history', 3);
      if (result.kind !== 'forward') throw new Error('expected forward');
      expect(result.search.get('nodeId')).toBeNull();
      expect(result.search.get('gitopsLocalTarget')).toBe('1');
      expect(result.search.get('limit')).toBe('10');
    });

    it('refuses history for a node this hop cannot answer for', () => {
      // Forwarding would make the remote answer about itself, which reads as an
      // answer to a question nobody asked.
      expect(prep('nodeId=7', '/git-sources/history', 3).kind).toBe('refuse');
      expect(prep('nodeId=7', '/stacks/web/git-source/history', 3).kind).toBe('refuse');
      expect(prep('nodeId=3', '/git-sources/history', undefined).kind).toBe('refuse');
    });

    it('narrows to the proxied node even when history names none', () => {
      // A request routed to this node is a question about this node. Without
      // the filter the remote answers with rows from all of its own nodes, and
      // the hub stamps a single id across every row it rewrites, so those rows
      // would come back claiming to belong to a node they do not.
      const result = prep('limit=5', '/git-sources/history', 3);
      if (result.kind !== 'forward') throw new Error('expected forward');
      expect(result.search.get('gitopsLocalTarget')).toBe('1');
      expect(result.search.get('limit')).toBe('5');
    });

    it('leaves the non-history routes without a node filter', () => {
      // Git sources are per-instance rather than per-node, so there is nothing
      // to narrow.
      const result = prep('', '/git-sources', 3);
      if (result.kind !== 'forward') throw new Error('expected forward');
      expect(result.search.get('gitopsLocalTarget')).toBeNull();
    });

    it('strips a forged local-target even when it refuses', () => {
      expect(prep('nodeId=7&gitopsLocalTarget=1', '/git-sources/history', 3).kind).toBe('refuse');
    });
  });

  describe('conditional requests', () => {
    it('strips every conditional request header before forwarding', () => {
      const removed: string[] = [];
      stripConditionalRequestHeaders({ removeHeader: (name) => removed.push(name) });
      expect(removed).toEqual(['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since']);
    });

    it('reruns the hub filter when a caller revalidates after a permission change', async () => {
      // First read: the caller may see both rows. The answer is filtered for
      // them and carries no validator to cache against.
      const row = (name: string): unknown => ({
        nodeId: 1,
        stack_name: name,
        gitopsRevision: { lifecycleStatus: 'active' },
        stackResourcePresent: true,
      });
      const first = await runResponse({
        status: 200,
        headers: { etag: 'W/"upstream-1"' },
        body: JSON.stringify([row('kept'), row('revoked')]),
      });
      expect(first.kind).toBe('rewrite');
      expect(JSON.parse(first.body.toString())).toHaveLength(2);
      expect(first.headers.etag).toBeUndefined();
      expect(first.headers['cache-control']).toBe('no-store');

      // The revalidation attempt: a conditional request is stripped on its way
      // up, so the remote cannot answer 304 and the hub must classify every
      // row again under the grants in force now.
      const outbound: Record<string, string> = { 'if-none-match': 'W/"upstream-1"', accept: 'application/json' };
      stripConditionalRequestHeaders({ removeHeader: (name) => { delete outbound[name]; } });
      expect(outbound['if-none-match']).toBeUndefined();
      expect(outbound.accept).toBe('application/json');

      // The fresh answer reflects the revocation: one row survives.
      const second = await runResponse({
        status: 200,
        body: JSON.stringify([row('kept'), row('revoked')]),
        transform: (payload) => (filterRemoteIdentityPayload(
          '/git-sources',
          payload,
          // The caller may still prove every row except the revoked stack.
          (requirement) => !(requirement.kind === 'stack_read' && requirement.stackName === 'revoked'),
          1,
        )),
      });
      expect(second.kind).toBe('rewrite');
      expect(JSON.parse(second.body.toString())).toHaveLength(1);
    });
  });

  describe('node id rewriting', () => {
    it('rewrites every enumerated position on a source row', () => {
      const payload = [{
        stack_name: 'web',
        nodeId: 1,
        stackResourcePresent: true,
        targets: [{ nodeId: 1 }, { nodeId: 2 }],
        gitopsRevision: {
          targets: [{ nodeId: 1 }],
          drift: [{ affectedTargets: [{ nodeId: 1 }, { nodeId: null }] }],
        },
        gitopsRevisions: [{ targets: [{ nodeId: 9 }] }],
      }];
      rewriteIdentityPayload(payload, 42);
      const row = payload[0];
      expect(row.nodeId).toBe(42);
      expect(row.targets.map(t => t.nodeId)).toEqual([42, 42]);
      expect(row.gitopsRevision.targets[0]?.nodeId).toBe(42);
      expect(row.gitopsRevision.drift[0]?.affectedTargets[0]?.nodeId).toBe(42);
      expect(row.gitopsRevisions[0]?.targets[0]?.nodeId).toBe(42);
    });

    it('preserves a null node rather than inventing a placement', () => {
      const payload = [{ nodeId: null, targets: [{ nodeId: null }] }];
      rewriteIdentityPayload(payload, 42);
      expect(payload[0]?.nodeId).toBeNull();
      expect(payload[0]?.targets[0]?.nodeId).toBeNull();
    });

    it('rewrites history items including their before and after projections', () => {
      const payload = {
        items: [{
          nodeId: 1,
          stackName: 'web',
          before: { targets: [{ nodeId: 1 }] },
          after: { targets: [{ nodeId: 1 }], drift: [{ affectedTargets: [{ nodeId: 1 }] }] },
        }],
        nextCursor: '100.abc',
      };
      rewriteIdentityPayload(payload, 42);
      const item = payload.items[0];
      expect(item?.nodeId).toBe(42);
      expect(item?.before.targets[0]?.nodeId).toBe(42);
      expect(item?.after.drift[0]?.affectedTargets[0]?.nodeId).toBe(42);
      expect(payload.nextCursor).toBe('100.abc');
    });

    it('rewrites the revision on a drift payload without touching the ledger', () => {
      // The drift payload is a single object whose GitOps content hangs off
      // `gitopsRevision`. Its own `findings` and `ledger` are the compose vs
      // runtime record and carry no node identity, so they must come back byte
      // for byte.
      const payload = {
        stack: 'web',
        status: 'drifted',
        findings: [{ service: 'app', kind: 'image-mismatch' }],
        ledger: [{ service: 'app', kind: 'image-mismatch', detectedAt: 5 }],
        gitopsRevision: {
          targets: [{ nodeId: 1 }],
          drift: [{ affectedTargets: [{ nodeId: 1 }] }],
        },
      };
      rewriteIdentityPayload(payload, 42);
      expect(payload.gitopsRevision.targets[0]?.nodeId).toBe(42);
      expect(payload.gitopsRevision.drift[0]?.affectedTargets[0]?.nodeId).toBe(42);
      expect(payload.findings).toEqual([{ service: 'app', kind: 'image-mismatch' }]);
      expect(payload.ledger).toEqual([{ service: 'app', kind: 'image-mismatch', detectedAt: 5 }]);
      expect(payload.stack).toBe('web');
    });

    it('leaves strings and unlisted keys untouched', () => {
      const payload = {
        applicationId: 'app-1',
        stackName: 'web',
        nodeId: '1',
        someOtherId: 1,
        targets: [{ nodeId: 1, stackName: 'web' }],
      };
      rewriteIdentityPayload(payload, 42);
      expect(payload.applicationId).toBe('app-1');
      expect(payload.stackName).toBe('web');
      expect(payload.nodeId).toBe('1');
      expect(payload.someOtherId).toBe(1);
      expect(payload.targets[0]?.stackName).toBe('web');
    });
  });

  describe('collection filtering', () => {
    it('drops rows in place and preserves order', () => {
      const payload = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const filtered = filterIdentityCollection(payload, row => (row as { id: string }).id !== 'b', () => true);
      expect(filtered).toEqual([{ id: 'a' }, { id: 'c' }]);
    });

    it('keeps the cursor when a page filters down to nothing', () => {
      // Otherwise a caller whose grants reject a whole window concludes the
      // history is empty instead of paging on.
      const payload = { items: [{ id: 'a' }], nextCursor: '100.abc' };
      const filtered = filterIdentityCollection(payload, () => true, () => false);
      expect(filtered).toEqual({ items: [], nextCursor: '100.abc' });
    });
  });

  describe('hub re-authorization of remote rows', () => {
    // A viewer holds global stack:read, so a row that reduces to a stack read
    // survives while anything unprovable falls to Admin or audit.
    const asViewer = (requirement: { kind: string }): boolean => requirement.kind === 'stack_read';

    const sourceRow = (stackName: string, lifecycleStatus: string, present: boolean) => ({
      stack_name: stackName,
      gitopsRevision: { schemaVersion: 1, targetMode: 'direct', lifecycleStatus },
      stackResourcePresent: present,
    });

    const historyItem = (stackName: string, lifecycleStatus: string | null, present: boolean) => ({
      stackName,
      applicationLifecycleStatus: lifecycleStatus,
      stackResourcePresent: present,
    });

    it('filters a source collection on the pre-rewrite path', () => {
      // The path must be the one the hub saw before pathRewrite prefixed
      // `/api`. Passing the rewritten path matches nothing and silently skips
      // re-authorization on every request.
      const payload = [
        sourceRow('web', 'active', true),
        sourceRow('gone', 'deleted', true),
        sourceRow('absent', 'active', false),
      ];
      const filtered = filterRemoteIdentityPayload('/git-sources', payload, asViewer, 7);
      expect(Array.isArray(filtered)).toBe(true);
      expect((filtered as Array<{ stack_name: string }>).map(r => r.stack_name)).toEqual(['web']);
    });

    it('filters a history collection on the pre-rewrite path', () => {
      const payload = {
        items: [
          historyItem('web', 'active', true),
          historyItem('creating-one', 'creating', true),
          historyItem('no-app', null, true),
        ],
        nextCursor: '100.abc',
      };
      const filtered = filterRemoteIdentityPayload('/git-sources/history', payload, asViewer, 7);
      const items = (filtered as { items: Array<{ stackName: string }> }).items;
      expect(items.map(i => i.stackName)).toEqual(['web']);
      expect((filtered as { nextCursor: string }).nextCursor).toBe('100.abc');
    });

    it('leaves a drift payload unfiltered', () => {
      // The drift routes are per-stack, authorized by name before the hop, and
      // return one object rather than a cross-stack collection. Re-filtering
      // them would hide a stack's own drift from the operator who just proved
      // they may read it.
      const payload = { stack: 'gone', gitopsRevision: { schemaVersion: 1, targetMode: 'direct', lifecycleStatus: 'deleted' } };
      expect(filterRemoteIdentityPayload('/stacks/gone/drift', payload, asViewer, 7)).toEqual(payload);
      expect(filterRemoteIdentityPayload('/stacks/gone/drift/recheck', payload, asViewer, 7)).toEqual(payload);
    });

    it('does not match the rewritten path, which is why the hop stashes the original', () => {
      // Pins the defect directly: with `/api` prefixed, nothing is filtered.
      const payload = [sourceRow('gone', 'deleted', true)];
      const filtered = filterRemoteIdentityPayload('/api/git-sources', payload, asViewer, 7);
      expect(filtered).toEqual(payload);
    });

    it('leaves per-stack routes unfiltered, since they were authorized by name', () => {
      const payload = { items: [historyItem('web', 'creating', true)] };
      const filtered = filterRemoteIdentityPayload('/stacks/web/git-source/history', payload, asViewer, 7);
      expect((filtered as { items: unknown[] }).items).toHaveLength(1);
    });
  });

  describe('terminal response rules', () => {
    it('rewrites a JSON 200 and reframes the body', async () => {
      const result = await runResponse({ status: 200, body: JSON.stringify([{ nodeId: 1 }]) });
      expect(result.kind).toBe('rewrite');
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(result.body.toString())).toEqual([{ nodeId: 42 }]);
      expect(result.headers['content-length']).toBe(String(result.body.length));
    });

    it('decodes a gzipped body before rewriting it', async () => {
      const result = await runResponse({
        status: 200,
        body: zlib.gzipSync(Buffer.from(JSON.stringify([{ nodeId: 1 }]))),
        headers: { 'content-encoding': 'gzip' },
      });
      expect(result.kind).toBe('rewrite');
      expect(JSON.parse(result.body.toString())).toEqual([{ nodeId: 42 }]);
      // The upstream framing described bytes that no longer exist, so it must
      // be gone rather than replayed over a body of a different length.
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['transfer-encoding']).toBeUndefined();
      expect(result.headers['content-length']).toBe(String(result.body.length));
      expect(result.finalizeCalls).toBe(1);
    });

    it('accumulates across chunks rather than checking one at a time', async () => {
      // A per-chunk check would let an arbitrarily large body through in small
      // pieces, so the cap has to be tested against a stream, not a buffer.
      const result = await runResponse({
        status: 200,
        body: '',
        chunks: Array.from({ length: 40 }, () => Buffer.alloc(32 * 1024, 0x61)),
      });
      expect(result.kind).toBe('too_large');
      expect(result.statusCode).toBe(502);
    });

    it('allows a body exactly at the ceiling', async () => {
      const exact = Buffer.concat([
        Buffer.from('"'),
        Buffer.alloc(IDENTITY_PROXY_MAX_BYTES - 2, 0x61),
        Buffer.from('"'),
      ]);
      const result = await runResponse({ status: 200, body: exact });
      expect(result.kind).toBe('rewrite');
    });

    it('passes a non-2xx body through without rewriting', async () => {
      const result = await runResponse({ status: 403, body: JSON.stringify({ error: 'denied' }) });
      expect(result.kind).toBe('passthrough');
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body.toString())).toEqual({ error: 'denied' });
    });

    it('refuses a 200 that will not parse instead of relaying it', async () => {
      // These routes answer with JSON on success, so an unparseable 200 is a
      // body the hub could not read. Relaying it under the remote's success
      // status would hand the client an unrewritten, unauthorized payload.
      const result = await runResponse({ status: 200, body: 'not json at all' });
      expect(result.kind).toBe('parse_error');
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body.toString()).code).toBe('gitops_proxy_unparseable');
    });

    it('blames itself, not the remote, when its own rewrite throws', async () => {
      const result = await runResponse({
        status: 200,
        body: JSON.stringify([{ nodeId: 1 }]),
        transform: () => { throw new Error('permission lookup failed'); },
      });
      expect(result.kind).toBe('rewrite_failed');
      // A 500, because everything in the transform runs on this instance.
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body.toString()).code).toBe('gitops_proxy_rewrite_failed');
    });

    it('treats a stream that ends incomplete as truncation', async () => {
      // Node's own truncation signal, rather than a hand-fired event: the
      // message ends without `complete`, which is what a remote dying mid-body
      // actually looks like.
      const result = await runResponse({ status: 200, body: '[{"nodeId":1}]', endIncomplete: true });
      expect(result.kind).toBe('upstream_failed');
      expect(result.statusCode).toBe(502);
    });

    it('writes no body for 204 and answers a 304 without the upstream validators', async () => {
      const noContent = await runResponse({ status: 204, body: '' });
      expect(noContent.statusCode).toBe(204);
      expect(noContent.body.length).toBe(0);
      expect(noContent.headers['cache-control']).toBe('no-store');

      const notModified = await runResponse({
        status: 304,
        body: '',
        headers: { etag: 'W/"abc"', 'last-modified': 'Mon, 18 Aug 2026 00:00:00 GMT', 'cache-control': 'max-age=60' },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body.length).toBe(0);
      // The upstream validators describe the remote's unfiltered
      // representation, not the page this hub sends, so relaying them would
      // let a cached page outlive the authorization it was filtered under.
      expect(notModified.headers.etag).toBeUndefined();
      expect(notModified.headers['last-modified']).toBeUndefined();
      expect(notModified.headers['cache-control']).toBe('no-store');
    });

    it('answers a rewritten page with no-store and no cache validators', async () => {
      const result = await runResponse({
        status: 200,
        body: JSON.stringify([{ nodeId: 1, stackName: 'web' }]),
        headers: {
          etag: 'W/"upstream-1"',
          'last-modified': 'Mon, 18 Aug 2026 00:00:00 GMT',
          expires: 'Mon, 18 Aug 2026 01:00:00 GMT',
          vary: 'Accept-Encoding',
          'cache-control': 'max-age=60',
        },
      });
      expect(result.kind).toBe('rewrite');
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers.etag).toBeUndefined();
      expect(result.headers['last-modified']).toBeUndefined();
      expect(result.headers.expires).toBeUndefined();
      expect(result.headers.vary).toBeUndefined();
    });

    it('preserves the location on a redirect', async () => {
      const result = await runResponse({
        status: 302,
        body: '',
        headers: { location: '/api/git-sources' },
      });
      expect(result.statusCode).toBe(302);
      expect(result.headers.location).toBe('/api/git-sources');
      // Every answer this hop writes is uncacheable, redirects included.
      expect(result.headers['cache-control']).toBe('no-store');
    });

    it('refuses a body past the ceiling with its own status', async () => {
      const oversized = 'x'.repeat(IDENTITY_PROXY_MAX_BYTES + 1024);
      const result = await runResponse({ status: 200, body: JSON.stringify([oversized]) });
      expect(result.kind).toBe('too_large');
      // Not the upstream 200: the hub could not read the answer.
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body.toString()).code).toBe('gitops_proxy_too_large');
      expect(result.headers['cache-control']).toBe('no-store');
    });

    it('reports an undecodable body as a decode failure', async () => {
      const result = await runResponse({
        status: 200,
        body: Buffer.from('this is not gzip'),
        headers: { 'content-encoding': 'gzip' },
      });
      expect(result.kind).toBe('decompress_error');
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body.toString()).code).toBe('gitops_proxy_decompress_failed');
    });

    it('reports a truncated upstream as a failure, not an empty success', async () => {
      const result = await runResponse({ status: 200, body: '[{"nodeId":1}]', abort: true });
      expect(result.kind).toBe('upstream_failed');
      expect(result.statusCode).toBe(502);
      expect(JSON.parse(result.body.toString()).code).toBe('gitops_proxy_upstream_failed');
    });

    it('finalizes once and writes nothing when the client hangs up', async () => {
      const result = await runResponse({ status: 200, body: JSON.stringify([{ nodeId: 1 }]), closeEarly: true });
      expect(result.kind).toBe('downstream_close');
      expect(result.ended).toBe(false);
      expect(result.finalizeCalls).toBe(1);
    });
  });
});

type ResponseCase = {
  status: number;
  body: string | Buffer;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  abort?: boolean;
  endIncomplete?: boolean;
  closeEarly?: boolean;
  transform?: (payload: unknown) => unknown;
};

type ResponseResult = {
  kind: IdentityTerminalKind;
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
  finalizeCalls: number;
};

/** Drive one upstream response through the terminal rules and capture what the client sees. */
function runResponse(testCase: ResponseCase): Promise<ResponseResult> {
  return new Promise((resolve) => {
    const proxyRes = new IncomingMessage(new Socket());
    proxyRes.statusCode = testCase.status;
    for (const [name, value] of Object.entries(testCase.headers ?? {})) {
      proxyRes.headers[name] = value;
    }

    // Pre-seeded with the framing the streaming hop would have set. Without
    // this the strip assertions pass vacuously, since removing a header that
    // was never present is indistinguishable from not stripping at all.
    const headers: Record<string, string> = {
      'content-length': '999',
      'content-encoding': 'gzip',
      'transfer-encoding': 'chunked',
    };
    let ended = false;
    let written = Buffer.alloc(0);
    let kind: IdentityTerminalKind | undefined;
    let finalizeCalls = 0;
    const closeListeners: Array<() => void> = [];

    const sink: IdentityResponseSink = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      removeHeader: (name) => { delete headers[name]; },
      setHeader: (name, value) => { headers[name] = String(value); },
      end: (body) => {
        ended = true;
        sink.writableEnded = true;
        if (body) written = Buffer.from(body);
        finish();
      },
      on: (_event, listener) => { closeListeners.push(listener); },
    };

    const finish = (): void => {
      resolve({
        kind: kind ?? 'passthrough',
        statusCode: sink.statusCode,
        headers,
        body: written,
        ended,
        finalizeCalls,
      });
    };

    handleIdentityResponse(proxyRes, sink, {
      transform: testCase.transform
        ?? ((payload) => { rewriteIdentityPayload(payload, 42); return payload; }),
      finalizeTiming: (terminal) => {
        kind = terminal;
        finalizeCalls += 1;
        if (terminal === 'downstream_close') setImmediate(finish);
      },
    });

    if (testCase.closeEarly) {
      for (const listener of closeListeners) listener();
      return;
    }

    const payload = Buffer.isBuffer(testCase.body) ? testCase.body : Buffer.from(testCase.body);
    if (testCase.abort) {
      proxyRes.push(payload.subarray(0, Math.max(1, payload.length - 4)));
      proxyRes.emit('aborted');
      return;
    }
    if (testCase.endIncomplete) {
      // `complete` deliberately left false, which is how Node itself reports a
      // body that stopped early.
      proxyRes.push(payload.subarray(0, Math.max(1, payload.length - 4)));
      proxyRes.push(null);
      return;
    }
    for (const chunk of testCase.chunks ?? []) proxyRes.push(chunk);
    if (payload.length > 0) proxyRes.push(payload);
    // A real HTTP response sets this once the parser has seen the whole body.
    // Without it a synthetic message reports every clean end as truncated.
    proxyRes.complete = true;
    proxyRes.push(null);
  });
}
