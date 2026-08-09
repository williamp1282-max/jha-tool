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

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN is not set on this deployment. Copy it from your Blob store\'s Quickstart tab in Vercel, add it under Project → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: ARCHIVE_PATHNAME, token });
      const match = blobs.find(b => b.pathname === ARCHIVE_PATHNAME);
      if (!match) {
        res.status(200).json({ archive: [] });
        return;
      }
      const fileRes = await fetch(match.url, { headers: { Authorization: `Bearer ${token}` } });
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
        token
      });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save the shared archive: ' + e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
