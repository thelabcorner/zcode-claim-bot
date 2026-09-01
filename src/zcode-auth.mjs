import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const CREDS_PATH = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');

export function loadToken() {
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const enc = raw['zcodejwttoken'];
  if (typeof enc !== 'string' || !enc.startsWith('enc:v1:')) {
    if (typeof enc === 'string' && enc.length > 20) return enc;
    throw new Error('zcodejwttoken not found in ' + CREDS_PATH);
  }
  const secret = process.env.ZCODE_CREDENTIAL_SECRET
    || `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const [ivB64, tagB64, dataB64] = enc.slice('enc:v1:'.length).split('.');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential cipher format invalid');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export function loadUserInfo() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    const v = raw['oauth:zai:user_info'];
    if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return null;
    const secret = process.env.ZCODE_CREDENTIAL_SECRET
      || `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
    const key = crypto.createHash('sha256').update(secret).digest();
    const [ivB64, tagB64, dataB64] = v.slice('enc:v1:'.length).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    d.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(dataB64, 'base64url')), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}
