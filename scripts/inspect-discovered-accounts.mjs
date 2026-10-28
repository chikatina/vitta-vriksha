/*
 * Inspect discovered accounts and print sample SMS messages and dates
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseAccountDetailsFromText } from '../app/src/main/assets/www/js/backend/database.js';

const inputPath = path.join('messages-2026-09-29', 'messages.ndjson');

async function inspect() {
  if (!fs.existsSync(inputPath)) {
    console.log(`Input file not found: ${inputPath}`);
    return;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  const targets = [
    '2219', '3800', '6101', '8386', '1846', '8916', '5075',
    '6165', '1189', '4106', '4686', '2025', '5703', '6395', '6003',
  ];

  const samples = new Map();
  for (const t of targets) {
    samples.set(t, []);
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const body = (msg.body || '').trim();
    const sender = (msg.address || '').trim();
    const date = msg.date ? new Date(Number(msg.date)).toISOString().slice(0, 10) : 'unknown';

    for (const t of targets) {
      if (body.includes(t)) {
        const arr = samples.get(t);
        if (arr.length < 5) {
          arr.push({ sender, date, body });
        }
      }
    }
  }

  for (const [target, list] of samples.entries()) {
    console.log(`\n=================== TARGET: ${target} (${list.length} samples) ===================`);
    list.forEach((s, i) => {
      console.log(`--- [${i + 1}] Date: ${s.date} | Sender: ${s.sender}`);
      console.log(`    ${s.body}`);
    });
  }
}

inspect().catch(console.error);
