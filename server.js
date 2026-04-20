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
