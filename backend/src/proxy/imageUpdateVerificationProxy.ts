import type { IncomingMessage } from 'http';
import type { Readable } from 'stream';
import type { Request, Response } from 'express';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';
import { awaitHubPostUpdateVerification, decorateUpdateResponse } from '../services/hubPostUpdateVerification';
import { RemoteImageUpdateService } from '../services/RemoteImageUpdateService';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const FRAMING_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'etag', 'last-modified']);

function responseStream(upstream: IncomingMessage): Readable {
  switch (upstream.headers['content-encoding']) {
    case 'gzip': return upstream.pipe(createGunzip());
    case 'deflate': return upstream.pipe(createInflate());
    case 'br': return upstream.pipe(createBrotliDecompress());
    default: return upstream;
  }
}

async function readResponse(upstream: IncomingMessage): Promise<unknown> {
  const stream = responseStream(upstream);
  const fail = (error: Error) => { stream.destroy(error); };
  upstream.on('error', fail);
  const timer = setTimeout(() => stream.destroy(new Error('Remote update response timed out')), RESPONSE_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Remote update response too large');
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    clearTimeout(timer);
    upstream.off('error', fail);
    stream.destroy();
    upstream.destroy();
  }
}

/** Transport adapter only; eligibility and verification belong to the shared service. */
export async function handleImageUpdateResponse(upstream: IncomingMessage, req: Request, res: Response): Promise<void> {
  const abort = () => { upstream.destroy(); };
  res.once('close', abort);
  try {
    const status = upstream.statusCode ?? 502;
    const body = await readResponse(upstream);
    if (res.destroyed) return;
    const stack = req.proxyNamedStackRoute?.stackName;
    if (!stack) throw new Error('Remote update response has no authorized stack identity');
    const verification = await awaitHubPostUpdateVerification({
      nodeId: req.nodeId, stack, targetResponse: { status, body }, caller: 'proxy',
      transport: RemoteImageUpdateService.getInstance(),
    });
    if (res.destroyed) return;
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && !FRAMING_HEADERS.has(name)) res.setHeader(name, value);
    }
    res.setHeader('cache-control', 'no-store');
    res.status(status).json(decorateUpdateResponse(body, verification));
  } catch (error) {
    console.warn('[Proxy] Could not read remote update result:', error);
    if (!res.destroyed && !res.headersSent) {
      res.status(502).json({ error: 'The remote update result could not be read. Check the stack before retrying.' });
    }
  } finally {
    res.off('close', abort);
  }
}
