#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// Parse CLI flags
const args = process.argv.slice(2);
let bumpType = 'patch'; // patch, minor, major, code-only
let targetCode = null;
let targetName = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) {
    bumpType = args[++i];
  } else if (args[i] === '--code' && args[i + 1]) {
    targetCode = parseInt(args[++i], 10);
  } else if (args[i] === '--name' && args[i + 1]) {
    targetName = args[++i];
  }
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

const currentCode = parseInt(codeMatch[1], 10);
const currentName = nameMatch[1];

// 2. Compute new versionCode
const newCode = targetCode && targetCode > 0 ? targetCode : currentCode + 1;

// 3. Compute new versionName
let newName = currentName;
if (targetName) {
  newName = targetName;
} else if (bumpType === 'code-only') {
  newName = currentName;
} else {
  const parts = currentName.split('.').map(p => parseInt(p, 10) || 0);
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
  } else {
    patch += 1;
  }
  newName = `${major}.${minor}.${patch}`;
}

console.log(`Auto Version Bump:`);
console.log(`  Previous: versionCode ${currentCode} | versionName "${currentName}"`);
console.log(`  New:      versionCode ${newCode} | versionName "${newName}"`);

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
