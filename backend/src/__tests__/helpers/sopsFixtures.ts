import crypto from 'crypto';

function sopsEncField(value: string, fileKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
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
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    ([key, value]) => `${key}: ${sopsEncField(value, fileKey)}`,
  );
  const indentedEnc = (await armorAgeFileKey(fileKey, args.recipient))
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');

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

export async function buildSopsAgeDotenvDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    ([key, value]) => `${key}=${sopsEncField(value, fileKey)}`,
  );
  const escapedEnc = (await armorAgeFileKey(fileKey, args.recipient)).replace(/\n/g, '\\n');

  return `${lines.join('\n')}
sops_mac=ENC[AES256_GCM,data:abc,iv:abc,tag:abc,type:str]
sops_version=3.9.0
sops_age__list_0__map_recipient=${args.recipient}
sops_age__list_0__map_enc=${escapedEnc}
`;
}

export async function buildSopsAgeIniDocument(args: {
  values: Record<string, string>;
  identity: string;
  recipient: string;
}): Promise<string> {
  const fileKey = crypto.randomBytes(32);
  const lines = Object.entries(args.values).map(
    ([key, value]) => `${key} = ${sopsEncField(value, fileKey)}`,
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
