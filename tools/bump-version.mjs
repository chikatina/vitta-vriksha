#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Parse CLI flags
const args = process.argv.slice(2);
let rawBumpType = 'patch'; // patch, minor, major, code-only, none
let targetCode = null;
let targetName = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) {
    rawBumpType = args[++i];
  } else if (args[i] === '--code' && args[i + 1]) {
    targetCode = parseInt(args[++i], 10);
  } else if (args[i] === '--name' && args[i + 1]) {
    targetName = args[++i];
  }
}

// Normalize bump type (handles choices like "patch (Z - bug fixes)", "minor (Y)", etc.)
const lower = (rawBumpType || '').toLowerCase();
let bumpType = 'none';
if (lower.includes('major')) {
  bumpType = 'major';
} else if (lower.includes('minor')) {
  bumpType = 'minor';
} else if (lower.includes('patch')) {
  bumpType = 'patch';
} else if (lower.includes('code')) {
  bumpType = 'code-only';
} else if (lower.includes('none')) {
  bumpType = 'none';
}

const rootDir = process.cwd();
const gradlePath = path.join(rootDir, 'app', 'build.gradle');
const packageJsonPath = path.join(rootDir, 'package.json');
const aboutPath = path.join(rootDir, 'app', 'src', 'main', 'assets', 'www', 'js', 'views', 'about.js');

if (!fs.existsSync(gradlePath)) {
  console.error('Error: Could not locate app/build.gradle. Run from repository root.');
  process.exit(1);
}

// 1. Read app/build.gradle
const gradleRaw = fs.readFileSync(gradlePath, 'utf8');
const codeMatch = gradleRaw.match(/versionCode\s*=?\s*(\d+)/);
const nameMatch = gradleRaw.match(/versionName\s*=?\s*"([^"]+)"/);

if (!codeMatch || !nameMatch) {
  console.error('Error: Could not parse versionCode or versionName from app/build.gradle');
  process.exit(1);
}

const localCode = parseInt(codeMatch[1], 10);
const localName = nameMatch[1];

function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Discover highest released versionCode and versionName from git tags and GitHub Releases
let highestCode = localCode;
let highestName = localName;

// Check local / fetched git tags
try {
  const tagsOut = execSync('git tag -l "v*"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  for (const rawTag of tagsOut.split('\n')) {
    const t = rawTag.trim().replace(/^v/, '');
    const sem = t.split('-')[0];
    if (sem && /^\d+\.\d+\.\d+$/.test(sem)) {
      if (compareSemver(sem, highestName) > 0) {
        highestName = sem;
      }
    }
  }
} catch {
  // Ignore git tag query failures in non-git environments
}

// Check GitHub Releases API if GITHUB_TOKEN or gh CLI is available
try {
  const repo = process.env.GITHUB_REPOSITORY || 'chikatina/vitta-vriksha';
  let jsonStr = '';
  if (process.env.GITHUB_TOKEN) {
    jsonStr = execSync(`curl -s -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" "https://api.github.com/repos/${repo}/releases?per_page=15"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } else {
    jsonStr = execSync(`gh api /repos/${repo}/releases?per_page=15`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  }
  const releases = JSON.parse(jsonStr);
  if (Array.isArray(releases)) {
    for (const r of releases) {
      const tag = r.tag_name?.trim().replace(/^v/, '').split('-')[0];
      if (tag && /^\d+\.\d+\.\d+$/.test(tag)) {
        if (compareSemver(tag, highestName) > 0) {
          highestName = tag;
        }
      }
      const bMatch = r.body?.match(/Build\s+(\d+)/i);
      if (bMatch) {
        const bCode = parseInt(bMatch[1], 10);
        if (bCode > highestCode) {
          highestCode = bCode;
        }
      }
    }
  }
} catch {
  // Ignore remote release lookup failures (offline / rate-limited)
}

if (bumpType === 'none' && !targetCode && !targetName) {
  console.log(`No version bump requested. Current: v${localName} (build ${localCode})`);
  process.exit(0);
}

// 2. Compute new versionCode (strictly greater than highestCode)
let newCode = highestCode;
if (targetCode && targetCode > 0) {
  newCode = targetCode;
} else if (bumpType !== 'none' || targetName) {
  newCode = highestCode + 1;
}

// 3. Compute new versionName (X.Y.Z)
let newName = highestName;
if (targetName) {
  newName = targetName.trim().replace(/^v/, '');
} else if (bumpType === 'code-only' || bumpType === 'none') {
  newName = highestName;
} else {
  const parts = highestName.split('.').map(p => parseInt(p, 10) || 0);
  let major = parts[0] || 1;
  let minor = parts[1] || 0;
  let patch = parts[2] || 0;

  if (bumpType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bumpType === 'patch') {
    patch += 1;
  }
  newName = `${major}.${minor}.${patch}`;
}

console.log(`Version Bump Result:`);
console.log(`  Bump selection:  ${rawBumpType}`);
console.log(`  Local on disk:   versionCode ${localCode} | versionName "${localName}"`);
console.log(`  Highest found:   versionCode ${highestCode} | versionName "${highestName}"`);
console.log(`  New release:     versionCode ${newCode} | versionName "${newName}"`);

// 4. Update app/build.gradle
let updatedGradle = gradleRaw.replace(/versionCode\s*=?\s*\d+/, `versionCode = ${newCode}`);
updatedGradle = updatedGradle.replace(/versionName\s*=?\s*"[^"]+"/, `versionName = "${newName}"`);
fs.writeFileSync(gradlePath, updatedGradle, 'utf8');
console.log(`[+] Updated ${gradlePath}`);

// 5. Update package.json if exists
if (fs.existsSync(packageJsonPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    pkg.version = newName;
    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[+] Updated ${packageJsonPath}`);
  } catch (err) {
    console.warn(`[!] Failed updating package.json:`, err.message);
  }
}

// 6. Update app/src/main/assets/www/js/views/about.js if exists
if (fs.existsSync(aboutPath)) {
  let aboutRaw = fs.readFileSync(aboutPath, 'utf8');
  aboutRaw = aboutRaw.replace(/Version \d+\.\d+\.\d+ \(Build \d+\)/g, `Version ${newName} (Build ${newCode})`);
  aboutRaw = aboutRaw.replace(/app_version_code \|\| \d+/g, `app_version_code || ${newCode}`);
  fs.writeFileSync(aboutPath, aboutRaw, 'utf8');
  console.log(`[+] Updated ${aboutPath}`);
}

console.log(`[+] Version bump complete.`);
