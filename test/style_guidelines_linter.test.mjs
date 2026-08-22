import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LINTER_PATH = path.join(ROOT, 'tools', 'check-style-guidelines.mjs');

describe('Style & Coding Standards Linter (AGENTS.md & STYLE_GUIDELINES.md)', () => {
  it('executes check-style-guidelines.mjs and verifies zero deviations', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [LINTER_PATH], {
      cwd: ROOT,
    });

    assert.ok(
      stdout.includes('All coding and styling guidelines verified successfully'),
      `Linter output must confirm zero deviations. Output: ${stdout}\nStderr: ${stderr}`,
    );
    assert.equal(stderr.trim(), '');
  });
});
