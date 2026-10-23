import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  uid: string;
  rid: string;
  exp: number; // epoch seconds
}

const b64 = (b: Buffer) => b.toString('base64url');

export function signSession(claims: SessionClaims, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(claims)));
  const sig = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined, secret: string): SessionClaims | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
