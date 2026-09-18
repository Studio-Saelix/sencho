import crypto from 'crypto';

export async function buildSopsAgeDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
}): Promise<string> {
  const age = await import('age-encryption');
  const fileKey = crypto.randomBytes(32);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args.values)) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    lines.push(
      `${key}: ENC[AES256_GCM,data:${encrypted.toString('base64')},iv:${iv.toString('base64')},tag:${tag.toString('base64')},type:str]`,
    );
  }

  const encrypter = new age.Encrypter();
  encrypter.addRecipient(args.recipient);
  const armored = age.armor.encode(await encrypter.encrypt(fileKey));
  const indentedEnc = armored.trimEnd().split('\n').map((line) => `        ${line}`).join('\n');

  return `${lines.join('\n')}
sops:
  age:
    - recipient: ${args.recipient}
      enc: |
${indentedEnc}
  mac: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
  version: 3.9.0
`;
}
