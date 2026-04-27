#!/usr/bin/env node
/**
 * Security scan review agent.
 * Reads ClamAV, Grype, Syft, and/or Trivy scan outputs and uses Claude to
 * determine whether the results are in good standing.
 *
 * Usage:
 *   node agent.js [--clamav=<file>] [--grype=<file>] [--syft=<file>] [--trivy=<file>]
 *
 * Exit codes:
 *   0  PASS / WARN  — no critical/high findings
 *   1  FAIL         — critical or high findings present, or malware detected
 *   2  ERROR        — agent could not run (bad args, API failure, etc.)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { parseArgs } from 'util';

const SYSTEM_PROMPT = `You are a security scan analyst. You receive raw output from one or more of these scanners: ClamAV, Grype, Syft, Trivy. Your job is to parse the results, identify genuine security risks, and return a structured verdict.

Verdict rules:
- FAIL  → any ClamAV malware detection, OR any CRITICAL/HIGH CVE from Grype or Trivy
- WARN  → only MEDIUM or LOW findings, or fixable issues with no critical impact
- PASS  → no findings, or purely informational output

Respond with ONLY a valid JSON object — no text before or after — in this exact shape:
{
  "verdict": "PASS" | "WARN" | "FAIL",
  "summary": "<one sentence describing overall status>",
  "scanners": {
    "clamav": { "status": "clean" | "infected" | "not_provided", "findings": ["<file: signature>"] },
    "grype":  { "status": "clean" | "findings" | "not_provided", "critical": 0, "high": 0, "medium": 0, "low": 0, "findings": ["<pkg@ver: CVE-XXXX-XXXXX (CRITICAL)>"] },
    "syft":   { "status": "generated" | "not_provided", "packages": 0 },
    "trivy":  { "status": "clean" | "findings" | "not_provided", "critical": 0, "high": 0, "medium": 0, "low": 0, "findings": ["<pkg@ver: CVE-XXXX-XXXXX (CRITICAL)>"] }
  },
  "details": "<full analysis in markdown — explain key findings, context, and recommended actions>"
}`;

function readScanFile(label, filePath) {
  if (!filePath) return null;
  if (!existsSync(filePath)) {
    console.error(`ERROR: ${label} file not found: ${filePath}`);
    process.exit(2);
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`ERROR: Could not read ${label} file: ${err.message}`);
    process.exit(2);
  }
}

function buildUserMessage(scans) {
  const parts = [];
  if (scans.clamav) parts.push(`## ClamAV Output\n\`\`\`\n${scans.clamav}\n\`\`\``);
  if (scans.grype)  parts.push(`## Grype Output (JSON)\n\`\`\`json\n${scans.grype}\n\`\`\``);
  if (scans.syft)   parts.push(`## Syft SBOM (JSON)\n\`\`\`json\n${scans.syft}\n\`\`\``);
  if (scans.trivy)  parts.push(`## Trivy Output (JSON)\n\`\`\`json\n${scans.trivy}\n\`\`\``);
  return parts.join('\n\n');
}

function printReport(result) {
  const icons = { PASS: '✓', WARN: '⚠', FAIL: '✗' };
  const icon = icons[result.verdict] ?? '?';

  console.log(`\n${icon} Verdict: ${result.verdict}`);
  console.log(`  ${result.summary}\n`);

  for (const [name, data] of Object.entries(result.scanners)) {
    if (data.status === 'not_provided') continue;

    if (name === 'syft') {
      console.log(`  [syft]    ${data.packages} packages in SBOM`);
      continue;
    }
    if (name === 'clamav') {
      const status = data.status === 'infected' ? `INFECTED (${data.findings.length} detections)` : 'clean';
      console.log(`  [clamav]  ${status}`);
      data.findings.forEach((f) => console.log(`              - ${f}`));
      continue;
    }
    const counts = `critical=${data.critical} high=${data.high} medium=${data.medium} low=${data.low}`;
    console.log(`  [${name.padEnd(6)}] ${data.status === 'clean' ? 'clean' : counts}`);
    if (data.findings?.length) {
      data.findings.slice(0, 10).forEach((f) => console.log(`              - ${f}`));
      if (data.findings.length > 10) console.log(`              … and ${data.findings.length - 10} more`);
    }
  }

  if (result.details) {
    console.log('\n── Details ──────────────────────────────────────────');
    console.log(result.details);
    console.log('─────────────────────────────────────────────────────\n');
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      clamav: { type: 'string' },
      grype:  { type: 'string' },
      syft:   { type: 'string' },
      trivy:  { type: 'string' },
    },
    strict: false,
  });

  const scans = {
    clamav: readScanFile('clamav', values.clamav),
    grype:  readScanFile('grype',  values.grype),
    syft:   readScanFile('syft',   values.syft),
    trivy:  readScanFile('trivy',  values.trivy),
  };

  if (!Object.values(scans).some(Boolean)) {
    console.error('ERROR: Provide at least one scan file via --clamav, --grype, --syft, or --trivy');
    console.error('Usage: node agent.js [--clamav=<file>] [--grype=<file>] [--syft=<file>] [--trivy=<file>]');
    process.exit(2);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(2);
  }

  const userMessage = buildUserMessage(scans);
  const client = new Anthropic({ apiKey });

  console.log('Analyzing scan results with Claude…');

  let rawResponse;
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });
    rawResponse = message.content.find((b) => b.type === 'text')?.text ?? '';
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('ERROR: Invalid ANTHROPIC_API_KEY');
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('ERROR: Rate limit hit — try again in a moment');
    } else {
      console.error(`ERROR: Claude API error — ${err.message}`);
    }
    process.exit(2);
  }

  // Strip any accidental markdown fences around the JSON
  const jsonText = rawResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch {
    console.error('ERROR: Claude returned non-JSON response:');
    console.error(rawResponse);
    process.exit(2);
  }

  printReport(result);

  process.exit(result.verdict === 'FAIL' ? 1 : 0);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
});
