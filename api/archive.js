// Vercel serverless function backed by Vercel Blob storage — this is what
// makes the JHA archive shared across every device/browser on the team,
// instead of living only in one browser's localStorage.
import { put, list } from '@vercel/blob';

const ARCHIVE_PATHNAME = 'jha-shared-archive.json';

export default async function handler(req, res) {
  // Same shared access code used by the AI hazard check — keeps the team
  // archive from being readable/writable by anyone who just finds the URL.
  const expectedCode = process.env.HAZARD_CHECK_PASSWORD;
  if (!expectedCode) {
    res.status(500).json({
      error: 'HAZARD_CHECK_PASSWORD is not set on this deployment. Add it under Vercel → Project → Settings → Environment Variables, then redeploy.'
    });
    return;
  }
  const providedCode = req.headers['x-access-code'];
  if (!providedCode || providedCode !== expectedCode) {
    res.status(401).json({ error: 'Incorrect access code.' });
    return;
  }

  // Vercel connects Blob stores using OIDC by default now (BLOB_STORE_ID +
  // a short-lived VERCEL_OIDC_TOKEN that Vercel rotates automatically),
  // rather than the older long-lived BLOB_READ_WRITE_TOKEN. Support both,
  // since either can be present depending on how the store was connected.
  const staticToken = process.env.BLOB_READ_WRITE_TOKEN;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  const storeId = process.env.BLOB_STORE_ID;
  if (!staticToken && !(oidcToken && storeId)) {
    res.status(500).json({
      error: 'No Blob store credentials found on this deployment. In Vercel: Storage → connect a Blob store to this project, then redeploy.'
    });
    return;
  }
  // When BLOB_READ_WRITE_TOKEN isn't set, omit `token` entirely so the SDK
  // falls back to its default OIDC-based authentication automatically.
  const sdkTokenOption = staticToken ? { token: staticToken } : {};
  const authHeaderToken = staticToken || oidcToken;

  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: ARCHIVE_PATHNAME, ...sdkTokenOption });
      const match = blobs.find(b => b.pathname === ARCHIVE_PATHNAME);
      if (!match) {
        res.status(200).json({ archive: [] });
        return;
      }
      const fileRes = await fetch(match.url, { headers: { Authorization: `Bearer ${authHeaderToken}` } });
      if (!fileRes.ok) {
        res.status(200).json({ archive: [] });
        return;
      }
      const data = await fileRes.json();
      res.status(200).json({ archive: Array.isArray(data) ? data : [] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load the shared archive: ' + e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    } catch (e) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const archive = Array.isArray(body.archive) ? body.archive : null;
    if (!archive) {
      res.status(400).json({ error: 'Missing archive array in request body.' });
      return;
    }
    try {
      await put(ARCHIVE_PATHNAME, JSON.stringify(archive), {
        access: 'private',
        contentType: 'application/json',
        allowOverwrite: true,
        ...sdkTokenOption
      });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save the shared archive: ' + e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
