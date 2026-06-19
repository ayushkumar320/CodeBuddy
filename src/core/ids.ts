import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateUlid(now: number = Date.now()): string {
  let timePart = "";
  let ts = now;
  for (let i = 0; i < 10; i++) {
    timePart = (CROCKFORD[ts % 32] ?? "0") + timePart;
    ts = Math.floor(ts / 32);
  }

  const bytes = randomBytes(10);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    const bitOffset = i * 5;
    const byteIndex = Math.floor(bitOffset / 8);
    const bitInByte = bitOffset % 8;
    const hi = bytes[byteIndex] ?? 0;
    const lo = bytes[byteIndex + 1] ?? 0;
    const combined = ((hi << 8) | lo) >>> 0;
    const shift = 16 - bitInByte - 5;
    const value = (combined >>> shift) & 0x1f;
    randPart += CROCKFORD[value] ?? "0";
  }

  return timePart + randPart;
}

export function generateSessionId(now?: number): string {
  return `sess_${generateUlid(now).toLowerCase()}`;
}

export function generateEntityId(prefix: string, now?: number): string {
  return `${prefix}_${generateUlid(now).toLowerCase()}`;
}

export function computeContentHash(namespace: string, sessionId: string, content: string): string {
  return createHash("sha256").update(`${namespace}\x1f${sessionId}\x1f${content}`).digest("hex");
}

export function computeFactHash(namespace: string, content: string): string {
  return createHash("sha256").update(`${namespace}\x1ffact\x1f${content}`).digest("hex");
}
