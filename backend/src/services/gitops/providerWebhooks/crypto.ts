import crypto from 'crypto';

export function timingSafeEqualHex(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.alloc(32);
  const provided = Buffer.alloc(32);
  let formatOk = false;
  if (/^[0-9a-fA-F]{64}$/.test(expectedHex) && /^[0-9a-fA-F]{64}$/.test(providedHex)) {
    expected.write(expectedHex, 'hex');
    provided.write(providedHex, 'hex');
    formatOk = true;
  }
  return formatOk && crypto.timingSafeEqual(expected, provided);
}

export function verifySha256PrefixedHmac(rawBody: Buffer, secret: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, parts[1]);
}

export function verifyRawHexHmac(rawBody: Buffer, secret: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, signatureHeader.trim());
}

export function verifyConstantTimeSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
