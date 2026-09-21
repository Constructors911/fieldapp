// Upload the finalized pay-period Hours PDF to Google Drive.
// Looks up or creates a folder named "911 Approved Payroll".
import { HttpError } from './util/httpError.js';

export const PAYROLL_FOLDER_NAME = '911 Approved Payroll';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function driveConfigured(env = process.env) {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return true;
  return Boolean(env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function payrollPdfFilename(from, to) {
  return `911-approved-payroll-${from}-to-${to}.pdf`;
}

export async function uploadPayrollPdf({
  filename,
  bytes,
  folderName = PAYROLL_FOLDER_NAME,
  folderId,
  existingFileId,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!driveConfigured(env)) {
    throw new HttpError(503, 'Google Drive is not configured — add a service account or Drive refresh token (see docs/GOOGLE_DRIVE.md)');
  }
  const token = await driveAccessToken(env, fetchImpl);
  const auth = { Authorization: `Bearer ${token}` };
  const parentId = folderId || env.GOOGLE_DRIVE_FOLDER_ID || await findOrCreateFolder({
    name: folderName,
    token,
    fetchImpl,
  });
  const fileId = existingFileId || await findFileInFolder({
    name: filename,
    folderId: parentId,
    token,
    fetchImpl,
  });
  const uploaded = fileId
    ? await patchDriveFile({ fileId, filename, bytes, token, fetchImpl })
    : await createDriveFile({ folderId: parentId, filename, bytes, token, fetchImpl });
  return {
    id: uploaded.id,
    name: uploaded.name || filename,
    url: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
    folderId: parentId,
    folderName,
  };
}

async function driveAccessToken(env, fetchImpl) {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return serviceAccountToken(parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON), fetchImpl);
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new HttpError(502, json.error_description || 'Google Drive sign-in failed');
  }
  return json.access_token;
}

function parseServiceAccount(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
}

async function serviceAccountToken(sa, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${signer.sign(sa.private_key, 'base64url')}`;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new HttpError(502, json.error_description || 'Google Drive service account sign-in failed');
  }
  return json.access_token;
}

function driveQuery(path) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  return url;
}

async function findOrCreateFolder({ name, token, fetchImpl }) {
  const q = driveQuery('files');
  q.searchParams.set('q', `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  q.searchParams.set('fields', 'files(id,name)');
  q.searchParams.set('pageSize', '1');
  const found = await fetchImpl(q, { headers: { Authorization: `Bearer ${token}` } });
  const list = await found.json().catch(() => ({}));
  if (!found.ok) throw new HttpError(502, list.error?.message || 'Could not look up the Drive payroll folder');
  if (list.files?.[0]?.id) return list.files[0].id;

  const created = await fetchImpl('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const json = await created.json().catch(() => ({}));
  if (!created.ok || !json.id) {
    throw new HttpError(502, json.error?.message || 'Could not create the 911 Approved Payroll folder');
  }
  return json.id;
}

async function findFileInFolder({ name, folderId, token, fetchImpl }) {
  const q = driveQuery('files');
  q.searchParams.set('q', `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`);
  q.searchParams.set('fields', 'files(id,name)');
  q.searchParams.set('pageSize', '1');
  const res = await fetchImpl(q, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return json.files?.[0]?.id || null;
}

async function createDriveFile({ folderId, filename, bytes, token, fetchImpl }) {
  const meta = JSON.stringify({
    name: filename,
    parents: [folderId],
    mimeType: 'application/pdf',
  });
  return uploadMultipart({
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    method: 'POST',
    meta,
    bytes,
    token,
    fetchImpl,
  });
}

async function patchDriveFile({ fileId, filename, bytes, token, fetchImpl }) {
  const meta = JSON.stringify({ name: filename, mimeType: 'application/pdf' });
  return uploadMultipart({
    url: `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
    method: 'PATCH',
    meta,
    bytes,
    token,
    fetchImpl,
  });
}

async function uploadMultipart({ url, method, meta, bytes, token, fetchImpl }) {
  const boundary = `c911_${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
    + `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), tail]);
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) {
    throw new HttpError(502, json.error?.message || 'Could not save the payroll PDF to Google Drive');
  }
  return json;
}
