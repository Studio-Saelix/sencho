import crypto from 'crypto';

/**
 * Fingerprint of Docker's apt repository release key
 * (https://download.docker.com/linux/ubuntu/gpg).
 */
export const DOCKER_RELEASE_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

const ARMOR_BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const ARMOR_END = '-----END PGP PUBLIC KEY BLOCK-----';
const TAG_PUBLIC_KEY = 6;

function dearmor(text: string): Buffer | null {
  const chunks: Buffer[] = [];
  let rest = text;
  for (;;) {
    const begin = rest.indexOf(ARMOR_BEGIN);
    if (begin === -1) break;
    const end = rest.indexOf(ARMOR_END, begin);
    if (end === -1) return null;
    // The text after the BEGIN marker starts with the rest of that line.
    const lines = rest.slice(begin + ARMOR_BEGIN.length, end).split(/\r?\n/).slice(1);
    // Armor headers (Version:, Comment:, ...) end at the first blank line; the
    // radix-64 body follows and ends before the "=XXXX" checksum line.
    const bodyStart = lines.findIndex((line) => line.trim() === '');
    const body = (bodyStart === -1 ? [] : lines.slice(bodyStart + 1))
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('='));
    if (body.length === 0 || !body.every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))) return null;
    chunks.push(Buffer.from(body.join(''), 'base64'));
    rest = rest.slice(end + ARMOR_END.length);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

interface Packet {
  tag: number;
  body: Buffer;
}

function readPackets(data: Buffer): Packet[] | null {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data[offset++];
    if ((header & 0x80) === 0) return null;
    let tag: number;
    let length: number;
    if (header & 0x40) {
      tag = header & 0x3f;
      const first = data[offset++];
      if (first === undefined) return null;
      if (first < 192) {
        length = first;
      } else if (first < 224) {
        const second = data[offset++];
        if (second === undefined) return null;
        length = ((first - 192) << 8) + second + 192;
      } else if (first === 255) {
        if (offset + 4 > data.length) return null;
        length = data.readUInt32BE(offset);
        offset += 4;
      } else {
        // Partial body lengths never frame key material.
        return null;
      }
    } else {
      tag = (header >> 2) & 0x0f;
      const lengthType = header & 0x03;
      if (lengthType === 3) {
        length = data.length - offset;
      } else {
        const width = 1 << lengthType;
        if (offset + width > data.length) return null;
        length = data.readUIntBE(offset, width);
        offset += width;
      }
    }
    if (offset + length > data.length) return null;
    packets.push({ tag, body: data.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Fingerprints of the primary public keys in an OpenPGP key file, or null when
 * the bytes are not a well-formed key file for the given name. Apt reads a
 * `.asc` keyring as ASCII armor and anything else as binary, so the extension
 * decides which form is accepted. A key whose format version this parser does
 * not fingerprint is reported as `v<N>` and never matches a pinned key.
 */
export function primaryKeyFingerprints(path: string, bytes: Buffer): string[] | null {
  const armored = /\.asc$/i.test(path);
  const data = armored ? dearmor(bytes.toString('utf8')) : bytes;
  if (!data || data.length === 0) return null;
  if (!armored && bytes.subarray(0, ARMOR_BEGIN.length).toString('utf8') === ARMOR_BEGIN) return null;
  const packets = readPackets(data);
  if (!packets) return null;
  const fingerprints: string[] = [];
  for (const packet of packets) {
    if (packet.tag !== TAG_PUBLIC_KEY) continue;
    const version = packet.body[0];
    if (version !== 4) {
      fingerprints.push(`v${version}`);
      continue;
    }
    const prefix = Buffer.from([0x99, (packet.body.length >> 8) & 0xff, packet.body.length & 0xff]);
    fingerprints.push(crypto.createHash('sha1').update(prefix).update(packet.body).digest('hex').toUpperCase());
  }
  return fingerprints.length > 0 ? fingerprints : null;
}

/** True only when the file holds Docker's release key and no other primary key. */
export function isDockerReleaseKeyFile(path: string, bytes: Buffer | null): boolean {
  if (!bytes) return false;
  const fingerprints = primaryKeyFingerprints(path, bytes);
  return fingerprints !== null && fingerprints.every((fingerprint) => fingerprint === DOCKER_RELEASE_KEY_FINGERPRINT);
}
