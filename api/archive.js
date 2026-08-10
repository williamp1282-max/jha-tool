// Vercel serverless function backed by Vercel Blob storage. Each saved JHA
// is stored as its own pair of files (a small ".meta.json" for the list
// view, plus the full record) rather than one big shared array — so two
// people saving different JHAs at the same time never clobber each other,
// and listing the archive doesn't require downloading every photo/signature
// embedded in every record.
import { put, list, del } from '@vercel/blob';

const PREFIX = 'jha-records/';
const metaPath = (id) => `${PREFIX}${id}.meta.json`;
const dataPath = (id) => `${PREFIX}${id}.json`;

function newId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

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

  const id = req.query && req.query.id;

  // ---- GET: list all records (metadata only), or fetch one full record ----
  if (req.method === 'GET') {
    if (id) {
      try {
        const { blobs } = await list({ prefix: dataPath(id), token });
        const match = blobs.find(b => b.pathname === dataPath(id));
        if (!match) {
          res.status(404).json({ error: 'That saved JHA was not found — it may have been deleted by someone else.' });
          return;
        }
        const fileRes = await fetch(match.url, { headers: { Authorization: `Bearer ${token}` } });
        if (!fileRes.ok) {
          res.status(502).json({ error: 'Failed to fetch the saved record.' });
          return;
        }
        const record = await fileRes.json();
        res.status(200).json({ record });
      } catch (e) {
        res.status(500).json({ error: 'Failed to load that record: ' + e.message });
      }
      return;
    }

    try {
      const { blobs } = await list({ prefix: PREFIX, token });
      const metaBlobs = blobs.filter(b => b.pathname.endsWith('.meta.json'));
      const metas = await Promise.all(metaBlobs.map(async (b) => {
        try {
          const r = await fetch(b.url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) return null;
          return await r.json();
        } catch (e) {
          return null;
        }
      }));
      res.status(200).json({ records: metas.filter(Boolean) });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list the shared archive: ' + e.message });
    }
    return;
  }

  // ---- POST: create or update a single record ----
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    } catch (e) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const record = body.record;
    if (!record || typeof record !== 'object') {
      res.status(400).json({ error: 'Missing record in request body.' });
      return;
    }

    const recId = record.id || newId();
    const meta = {
      id: recId,
      jhaNo: record.jhaNo || '',
      task: record.task || '',
      location: record.location || '',
      savedAt: record.savedAt || new Date().toISOString()
    };
    const full = { ...record, id: recId, savedAt: meta.savedAt };

    try {
      await put(dataPath(recId), JSON.stringify(full), {
        access: 'private', contentType: 'application/json', allowOverwrite: true, token
      });
      await put(metaPath(recId), JSON.stringify(meta), {
        access: 'private', contentType: 'application/json', allowOverwrite: true, token
      });
      res.status(200).json({ id: recId });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save that record: ' + e.message });
    }
    return;
  }

  // ---- DELETE: remove one record ----
  if (req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Missing id.' });
      return;
    }
    try {
      await del([dataPath(id), metaPath(id)], { token });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete that record: ' + e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
