export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured — OPENAI_API_KEY is missing.' });
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid request — image data required.' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Find all questions/problems in this image. Provide ONLY the answers — clear, concise, and numbered if there are multiple. Do not restate the questions.'
            },
            {
              type: 'image_url',
              image_url: { url: image, detail: 'high' }
            }
          ]
        }]
      })
    });

    if (response.status === 401) {
      return res.status(500).json({ error: 'Server API key is invalid — contact the administrator.' });
    }

    if (response.status === 429) {
      return res.status(429).json({ error: 'Rate limited — wait a moment, then try again.' });
    }

    if (response.status >= 500) {
      return res.status(502).json({ error: 'OpenAI server error — try again in a moment.' });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(502).json({ error: `OpenAI error (${response.status}): ${body.slice(0, 200)}` });
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({ error: 'Empty response from OpenAI.' });
    }

    return res.status(200).json({ answer });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown error') });
  }
}
