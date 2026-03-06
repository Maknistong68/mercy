const SYSTEM_PROMPT = `You are an expert in Industrial Engineering and all related fields: operations research, quality management & control, statistics, probability, ergonomics, human factors, supply chain management, logistics, production planning & control, engineering economics, manufacturing processes, facilities planning & layout, work study, methods engineering, time & motion study, inventory management, lean manufacturing, Six Sigma, project management, engineering mathematics, thermodynamics, and material science.

You will be shown an image containing one or more multiple choice questions. Your task:
1. Identify each question. Number them Q1, Q2, etc.
2. Determine the correct answer using the EXACT choice label as written in the image. Do NOT convert labels — if choices are labeled 1, 2, 3, 4 use those numbers. If A, B, C, D use those letters. If True/False use that. Whatever the labeling is, use it exactly.
3. Give a brief explanation (1-2 sentences) for each.

STRICT OUTPUT FORMAT — follow exactly:
Q1: [exact choice label]
Explanation: [brief reason]

Q2: [exact choice label]
Explanation: [brief reason]

If you cannot determine the answer with certainty, still provide your best choice and note your uncertainty in the explanation.`;

const USER_PROMPT = 'Analyze this image. Identify all multiple choice questions and provide the correct answers following the format specified.';

const VERIFICATION_ROUNDS = 3;

function parseAnswers(text) {
  const matches = [...text.matchAll(/Q(\d+):\s*(.+)/gi)];
  const map = {};
  for (const m of matches) {
    const qNum = m[1];
    // Extract just the choice — stop at newline, and strip "Explanation:" if on same line
    let choice = m[2].trim();
    // If "Explanation:" is on the same line, take only the part before it
    const explIdx = choice.toLowerCase().indexOf('explanation');
    if (explIdx > 0) choice = choice.substring(0, explIdx).trim();
    // Remove trailing punctuation
    choice = choice.replace(/[.,;:\-]+$/, '').trim();
    map[`Q${qNum}`] = choice.toUpperCase();
  }
  return map;
}

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
    const requestBody = {
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            { type: 'image_url', image_url: { url: image, detail: 'high' } }
          ]
        }
      ]
    };

    // Fire 3 parallel verification rounds
    const promises = Array.from({ length: VERIFICATION_ROUNDS }, () =>
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      }).then(async (response) => {
        if (response.status === 401) throw new Error('API_KEY_INVALID');
        if (response.status === 429) throw new Error('RATE_LIMITED');
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`OpenAI ${response.status}: ${text.slice(0, 200)}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
      }).catch(err => ({ error: err.message }))
    );

    const results = await Promise.all(promises);

    // Check for critical errors that should abort entirely
    for (const r of results) {
      if (r && r.error === 'API_KEY_INVALID') {
        return res.status(500).json({ error: 'Server API key is invalid — contact the administrator.' });
      }
      if (r && r.error === 'RATE_LIMITED') {
        return res.status(429).json({ error: 'Rate limited — wait a moment, then try again.' });
      }
    }

    // Filter successful responses
    const successful = results.filter(r => typeof r === 'string' && r.length > 0);

    if (successful.length === 0) {
      const firstError = results.find(r => r && r.error);
      return res.status(502).json({
        error: 'All verification rounds failed.' + (firstError ? ' ' + firstError.error : '')
      });
    }

    // Parse answers from each round
    const parsed = successful.map(parseAnswers);

    // Collect all question keys
    const allKeys = [...new Set(parsed.flatMap(p => Object.keys(p)))].sort(
      (a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))
    );

    // Compute consensus per question
    let agreedCount = 0;
    const details = {};

    for (const key of allKeys) {
      const votes = parsed.map(p => p[key]).filter(Boolean);
      const tally = {};
      for (const v of votes) {
        tally[v] = (tally[v] || 0) + 1;
      }
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const [bestChoice, bestCount] = sorted[0];
      const unanimous = bestCount === votes.length;
      details[key] = { choice: bestChoice, votes: bestCount, total: votes.length, unanimous };
      if (unanimous) agreedCount++;
    }

    // Pick the response that best matches consensus
    let bestResponse = successful[0];
    let bestMatchCount = 0;
    for (let i = 0; i < successful.length; i++) {
      let matchCount = 0;
      for (const key of allKeys) {
        if (parsed[i][key] === details[key].choice) matchCount++;
      }
      if (matchCount > bestMatchCount) {
        bestMatchCount = matchCount;
        bestResponse = successful[i];
      }
    }

    const totalQuestions = allKeys.length;
    const roundsCompleted = successful.length;

    const perQuestion = allKeys.map(key => {
      const d = details[key];
      const status = d.unanimous ? 'verified' : 'review';
      return `${key}: ${d.choice} (${d.votes}/${d.total} — ${status})`;
    }).join('\n');

    const summary = totalQuestions > 0
      ? `${agreedCount}/${totalQuestions} verified (${roundsCompleted} rounds)`
      : `${roundsCompleted} rounds completed`;

    return res.status(200).json({
      answer: bestResponse,
      confidence: { summary, perQuestion, agreedCount, totalQuestions, roundsCompleted, details }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown error') });
  }
}
