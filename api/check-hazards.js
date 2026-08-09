// Vercel serverless function — runs server-side only, so the API key never
// reaches the browser. Deployed automatically because it lives in /api.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set on this deployment. Add it under Vercel → Project → Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ error: 'Invalid request body.' });
    return;
  }

  const { task, description, location, steps } = body;
  if (!Array.isArray(steps) || steps.length === 0) {
    res.status(400).json({ error: 'Add at least one task step before running a check.' });
    return;
  }

  const stepsSummary = steps.map((s, i) =>
    `Step ${i + 1}: ${s.step || '(no description)'}\n` +
    `  Hazard: ${s.hazard || '(none listed)'}\n` +
    `  Consequence: ${s.consequence || '(none listed)'}\n` +
    `  Likelihood: ${s.likelihood || '(none listed)'}\n` +
    `  Contributing factors: ${s.factors || '(none listed)'}\n` +
    `  Control measures: ${s.control || '(none listed)'}`
  ).join('\n\n');

  const userPrompt = `Task/Operation: ${task || '(not specified)'}
Description: ${description || '(not specified)'}
Location: ${location || '(not specified)'}

Existing task steps and hazard analysis:
${stepsSummary}

Review this Job Hazard Analysis as an experienced occupational safety professional. Identify hazards that appear to be MISSING or under-addressed for these steps. Do not repeat hazards already listed above. For each gap you find, reference the step number it relates to (use 0 for a general/site-wide hazard not tied to one specific step).

Respond with ONLY a JSON array, no other text before or after it, in exactly this shape:
[{"stepNumber": 1, "hazard": "...", "consequence": "...", "likelihood": "Low", "factors": "...", "control": "..."}]

likelihood must be exactly one of: Low, Medium, High. If you find no significant gaps, respond with exactly: []`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: `Anthropic API error (${response.status}): ${errText.slice(0, 300)}` });
      return;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text : '[]';

    let suggestions;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      suggestions = JSON.parse(cleaned);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch (e) {
      suggestions = [];
    }

    res.status(200).json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reach Anthropic API: ' + e.message });
  }
}
