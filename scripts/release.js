#!/usr/bin/env node
// Rilascio di un'estensione: versione nel manifest (e nel package.json se c'è), sezione
// [Unreleased] del CHANGELOG che diventa la versione, catalogo rigenerato, commit e tag
// "<codice>@<versione>". La pubblicazione resta un comando esplicito (git push).
//   npm run release <codice> <patch|minor|major> [--push]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const [code, level] = process.argv.slice(2);
const push = process.argv.includes('--push');
const fail = msg => { console.error(msg); process.exit(1); };
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(code || '') || !['patch', 'minor', 'major'].includes(level)) {
  fail('Uso: npm run release <codice> <patch|minor|major> [--push]');
}
const dir = path.join(ROOT, code);
const settingFile = path.join(dir, 'setting.json');
if (!fs.existsSync(settingFile)) fail(`Estensione non trovata: ${code}`);
if (git('status', '--porcelain')) fail('Ci sono modifiche non salvate: fai prima il commit');

const setting = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
const [major, minor, patch] = setting.version.split('.').map(Number);
const version = level === 'major' ? `${major + 1}.0.0` : level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
const tag = `${code}@${version}`;
if (git('tag', '--list', tag)) fail(`Il tag ${tag} esiste già`);

// CHANGELOG: [Unreleased] → [versione] - data (una sezione vuota blocca il rilascio)
const changelogFile = path.join(dir, 'CHANGELOG.md');
const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : '';
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## |\s*$)/.exec(changelog);
if (!unreleased || !unreleased[1].trim()) fail(`${code}/CHANGELOG.md: la sezione [Unreleased] è vuota`);
const date = new Date().toISOString().slice(0, 10);
fs.writeFileSync(changelogFile, changelog.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`));

// versione con lo stesso formato del file (rientro di 2 spazi)
fs.writeFileSync(settingFile, fs.readFileSync(settingFile, 'utf8').replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
const pkgFile = path.join(dir, 'package.json');
if (fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, fs.readFileSync(pkgFile, 'utf8').replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));

execFileSync(process.execPath, [path.join(__dirname, 'catalog.js')], { cwd: ROOT, stdio: 'inherit' });
git('add', '-A', code, 'index.json');
git('commit', '-m', `${code} ${version}`);
git('tag', '-a', tag, '-m', `${code} ${version}`);
console.log(`Creato il tag ${tag}`);
if (push) {
  execFileSync('git', ['push', 'origin', 'HEAD', tag], { cwd: ROOT, stdio: 'inherit' });
} else {
  console.log(`Per pubblicarlo: git push origin HEAD ${tag}`);
}
