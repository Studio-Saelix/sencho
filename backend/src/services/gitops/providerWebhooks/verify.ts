import type { GitProviderKind } from './types';
import { verifyConstantTimeSecret, verifyRawHexHmac, verifySha256PrefixedHmac } from './crypto';

export function verifyProviderSignature(
  provider: GitProviderKind,
  rawBody: Buffer,
  secret: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  switch (provider) {
    case 'github':
      return verifySha256PrefixedHmac(rawBody, secret, header('x-hub-signature-256'));
    case 'gitlab': {
      const tokenOk = verifyConstantTimeSecret(header('x-gitlab-token'), secret);
      const sig256 = header('x-gitlab-hook-signature-256');
      if (sig256) {
        const sigOk = verifySha256PrefixedHmac(rawBody, secret, sig256);
        return sigOk;
      }
      return tokenOk;
    }
    case 'gitea':
      return verifyRawHexHmac(rawBody, secret, header('x-gitea-signature'));
    case 'forgejo': {
      const forgejo = header('x-forgejo-signature');
      if (forgejo) return verifyRawHexHmac(rawBody, secret, forgejo);
      return verifyRawHexHmac(rawBody, secret, header('x-gitea-signature'));
    }
    case 'bitbucket_cloud':
      return verifySha256PrefixedHmac(rawBody, secret, header('x-hub-signature'));
    default:
      return false;
  }
}
