import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({ serverKeyConfigured: !!process.env.ANTHROPIC_API_KEY });
});

/* ── PII / PHI / Classified scanner ─────────────────────── */
const SCAN_SYSTEM_PROMPT = `You are a sensitive data detection system. Analyze the provided text and identify ALL sensitive information.

Return ONLY a valid JSON object in this exact format:
{"detections": [{"type": "TYPE", "value": "exact text found", "category": "CATEGORY", "severity": "SEVERITY", "reason": "brief explanation"}]}

Types: SSN, EMAIL, PHONE, CREDIT_CARD, BANK_ACCOUNT, ROUTING_NUMBER, NAME, ADDRESS, DOB, IP_ADDRESS, MRN, HEALTH_CONDITION, INSURANCE_ID, NPI, DIAGNOSIS, TREATMENT, MEDICATION, CLASSIFICATION_MARKING, API_KEY, PASSWORD, PASSPORT, DRIVERS_LICENSE, OTHER_PII, OTHER_PHI, OTHER_FINANCIAL

Categories: PII, PHI, FINANCIAL, CLASSIFIED, CREDENTIALS

Severity:
- HIGH: SSN, credit cards, bank accounts, medical record numbers, passwords, API keys, govt IDs, health conditions, diagnoses, insurance IDs
- MEDIUM: Full names with addresses or DOBs, phone numbers, NPI numbers, medication with patient context
- LOW: Email addresses alone, general location references, partial dates

If no sensitive data is found return: {"detections": []}
Return ONLY the JSON. No prose, no markdown.`;

const REGEX_PATTERNS = [
  { type: 'SSN',                   category: 'PII',         severity: 'HIGH',   regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g },
  { type: 'EMAIL',                 category: 'PII',         severity: 'MEDIUM', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'PHONE',                 category: 'PII',         severity: 'MEDIUM', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  { type: 'CREDIT_CARD',           category: 'FINANCIAL',   severity: 'HIGH',   regex: /\b4\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b5[1-5]\d{2}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g },
  { type: 'IP_ADDRESS',            category: 'PII',         severity: 'LOW',    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { type: 'API_KEY',               category: 'CREDENTIALS', severity: 'HIGH',   regex: /\bsk-ant-api[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{40,}\b/g },
  { type: 'CLASSIFICATION_MARKING',category: 'CLASSIFIED',  severity: 'HIGH',   regex: /\b(?:TOP\s+SECRET|SECRET|CONFIDENTIAL|PROPRIETARY|INTERNAL\s+USE\s+ONLY|CLASSIFIED)\b/gi },
  { type: 'MRN',                   category: 'PHI',         severity: 'HIGH',   regex: /\bMR[N#]?\s*:?\s*\d{5,10}\b/gi },
  { type: 'NPI',                   category: 'PHI',         severity: 'HIGH',   regex: /\bNPI\s*:?\s*\d{10}\b/gi },
];

function runRegexScan(text) {
  const detections = [];
  for (const { type, category, severity, regex } of REGEX_PATTERNS) {
    const r = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = r.exec(text)) !== null) {
      detections.push({ type, category, severity, value: match[0], reason: 'Pattern match' });
    }
  }
  return detections;
}

app.post('/api/scan', async (req, res) => {
  const { text, apiKey } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.json({ detections: [] });

  // Regex layer always runs (no API key needed)
  const regexDetections = runRegexScan(text);

  // Claude semantic layer only when a key is available
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return res.json({ detections: regexDetections });

  try {
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SCAN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const parsed = JSON.parse(response.content[0].text);
    const claudeDetections = (parsed.detections || []).filter(d => d.value);

    const seen = new Set(regexDetections.map(d => d.value.toLowerCase()));
    const merged = [...regexDetections, ...claudeDetections.filter(d => !seen.has(d.value.toLowerCase()))];
    res.json({ detections: merged });
  } catch {
    res.json({ detections: regexDetections });
  }
});

app.post('/api/chat', async (req, res) => {
  const {
    messages,
    model = 'claude-opus-4-7',
    system = 'You are a helpful AI assistant.',
    apiKey,
    showThinking = false,
  } = req.body;

  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(401).json({
      error: 'No API key. Set ANTHROPIC_API_KEY in your environment or add it in Settings.',
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const client = new Anthropic({ apiKey: key });

    const supportsThinking =
      model.includes('opus') || model === 'claude-sonnet-4-6';

    const params = {
      model,
      max_tokens: 16000,
      // Cache the system prompt across turns for cost efficiency
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };

    if (showThinking && supportsThinking) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
    }

    const stream = client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta' && showThinking) {
          emit({ type: 'thinking', text: event.delta.thinking });
        } else if (event.delta.type === 'text_delta') {
          emit({ type: 'text', text: event.delta.text });
        }
      }
    }

    const final = await stream.finalMessage();
    emit({
      type: 'done',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
        cacheCreated: final.usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (err) {
    let message = 'An unexpected error occurred.';
    if (err instanceof Anthropic.AuthenticationError) {
      message = 'Invalid API key. Please check your key in Settings.';
    } else if (err instanceof Anthropic.RateLimitError) {
      message = 'Rate limit exceeded. Please wait a moment and try again.';
    } else if (err instanceof Anthropic.BadRequestError) {
      message = `Bad request: ${err.message}`;
    } else if (err instanceof Anthropic.APIError) {
      message = `API error (${err.status}): ${err.message}`;
    } else if (err?.message) {
      message = err.message;
    }
    emit({ type: 'error', error: message });
  }

  if (!res.writableEnded) res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nAI Chat → http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Tip: set ANTHROPIC_API_KEY, or enter your key in the app Settings.\n');
  }
});
