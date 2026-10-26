import crypto from 'crypto';

function sopsEncField(value: string, fileKey: Buffer, aad: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC[AES256_GCM,data:${encrypted.toString('base64')},iv:${iv.toString('base64')},tag:${tag.toString('base64')},type:str]`;
}

async function armorAgeFileKey(fileKey: Buffer, recipient: string): Promise<string> {
  const age = await import('age-encryption');
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  return age.armor.encode(await encrypter.encrypt(fileKey)).trimEnd();
}

export async function buildSopsAgeDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
  /** Additional recipients the same file key is wrapped for, beside `recipient`. */
  extraRecipients?: string[];
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    ([key, value]) => `${key}: ${sopsEncField(value, fileKey, `${key}:`)}`,
  );
  const ageEntries = await Promise.all(
    [args.recipient, ...(args.extraRecipients ?? [])].map(async (recipient) => {
      const enc = (await armorAgeFileKey(fileKey, recipient))
        .split('\n')
        .map((line) => `        ${line}`)
        .join('\n');
      return `    - recipient: ${recipient}\n      enc: |\n${enc}`;
    }),
  );

  return `${lines.join('\n')}
sops:
  age:
${ageEntries.join('\n')}
  mac: ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
  version: 3.9.0
`;
}

export async function buildSopsAgeDotenvDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
  /** Additional recipients the same file key is wrapped for, beside `recipient`. */
  extraRecipients?: string[];
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    ([key, value]) => `${key}=${sopsEncField(value, fileKey, `${key}:`)}`,
  );
  const ageLines = (await Promise.all(
    [args.recipient, ...(args.extraRecipients ?? [])].map(async (recipient, index) => {
      const escapedEnc = (await armorAgeFileKey(fileKey, recipient)).replace(/\n/g, '\\n');
      return `sops_age__list_${index}__map_recipient=${recipient}\nsops_age__list_${index}__map_enc=${escapedEnc}`;
    }),
  )).join('\n');

  return `${lines.join('\n')}
sops_mac=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_version=3.9.0
${ageLines}
`;
}

export async function buildSopsAgeIniDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    // Keys before any section live in the implicit DEFAULT section.
    ([key, value]) => `${key} = ${sopsEncField(value, fileKey, `DEFAULT:${key}:`)}`,
  );
  const escapedEnc = (await armorAgeFileKey(fileKey, args.recipient)).replace(/\n/g, '\\n');

  return `${lines.join('\n')}

[sops]
mac = ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
version = 3.9.0
age__list_0__map_recipient = ${args.recipient}
age__list_0__map_enc = ${escapedEnc}
`;
}
