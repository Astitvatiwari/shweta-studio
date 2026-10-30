import crypto from 'node:crypto';

export function verifyNetlifyProxySignature(token, secret, { nowSeconds = Math.floor(Date.now() / 1000), expectedSiteUrl = '' } = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || claims.iss !== 'netlify' || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds) return false;
    if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds)) return false;
    if (expectedSiteUrl && claims.site_url !== expectedSiteUrl) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest();
    const actual = Buffer.from(encodedSignature, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function safeClientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isSafeClientError = true;
  return error;
}

export function safeAdminKeyMatch(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
