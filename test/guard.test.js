'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'guard.js');
const EXAMPLE_LEXICON = path.join(ROOT, 'lexicon.example.json');

function guard(args, opts = {}) {
  const r = spawnSync(process.execPath, [GUARD, ...args], { cwd: opts.cwd || ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ex = (...args) => guard([...args, '--lexicon', EXAMPLE_LEXICON]);

let tmp;
const write = (rel, content) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const lexiconFile = (obj, name = 'lex.json') => write(name, typeof obj === 'string' ? obj : JSON.stringify(obj));
const rule = (over = {}) => ({ id: 'R1', pattern: 'forbidden', severity: 'blocker', scope: 'all', ...over });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexicon-guard-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exit 0', () => {
  test('clean file', () => {
    const f = write('clean/ok.md', 'Acme Signals is designed for 99.9% availability.\n');
    const r = ex(f);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 file scanned · 0 BLOCKER · 0 warn/);
    assert.match(r.stdout, /RESULT: PASS · clean/);
  });

  test('warnings only', () => {
    const f = write('warn/w.md', 'Alerts arrive in real-time.\n');
    const r = ex(f);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0 BLOCKER · 1 warn/);
    assert.match(r.stdout, /━━ WARNINGS ━━/);
    assert.doesNotMatch(r.stdout, /━━ BLOCKERS ━━/);
  });

  test('--help and --version', () => {
    assert.equal(guard(['--help']).code, 0);
    const v = guard(['--version']);
    assert.equal(v.code, 0);
    assert.equal(v.stdout.trim(), require('../package.json').version);
  });
});

describe('exit 1', () => {
  test('example docs fail with every rule firing', () => {
    const r = ex('examples/docs');
    assert.equal(r.code, 1);
    const lexicon = JSON.parse(fs.readFileSync(EXAMPLE_LEXICON, 'utf8'));
    for (const { id } of lexicon.rules) assert.match(r.stdout, new RegExp(`\\[${id}\\]`), `${id} should fire`);
  });

  test('README sample output is the real output of the example run', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const m = readme.match(/node guard\.js examples\/docs --lexicon lexicon\.example\.json\n```\n\n```\n([\s\S]*?)```/);
    assert.ok(m, 'README quick start sample not found');
    const r = guard(['examples/docs', '--lexicon', 'lexicon.example.json']);
    assert.equal(r.stdout, m[1]);
  });
});

describe('exit 2', () => {
  test('unknown flag', () => {
    const r = ex('examples/docs', '--verbose');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown flag: --verbose/);
  });

  test('flag value errors', () => {
    assert.equal(guard(['examples/docs', '--lexicon']).code, 2);
    assert.equal(ex('examples/docs', '--scope', 'everyone').code, 2);
    assert.equal(ex('examples/docs', '--json=yes').code, 2);
  });

  test('missing path argument and nonexistent path', () => {
    assert.match(ex().stderr, /missing path/);
    assert.equal(ex().code, 2);
    const r = ex('does/not/exist.md');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /path not found/);
  });

  test('unreadable lexicon: missing file and invalid JSON', () => {
    const r = guard(['examples/docs', '--lexicon', path.join(tmp, 'nope.json')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot read lexicon/);
    const bad = lexiconFile('{ "rules": [', 'broken.json');
    assert.equal(guard(['examples/docs', '--lexicon', bad]).code, 2);
  });

  test('bad regex in a rule', () => {
    const lex = lexiconFile({ rules: [rule({ pattern: '(unclosed' })] }, 'badregex.json');
    const r = guard(['examples/docs', '--lexicon', lex]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /rule R1: invalid regex/);
  });

  test('bad regex in internalPaths', () => {
    const lex = lexiconFile({ internalPaths: ['[oops'], rules: [rule()] }, 'badpaths.json');
    assert.equal(guard(['examples/docs', '--lexicon', lex]).code, 2);
  });

  test('invalid rules', () => {
    const cases = [
      { rules: [] },
      { rules: [rule({ severity: 'error' })] },
      { rules: [rule({ scope: 'public' })] },
      { rules: [rule({ id: '' })] },
      { rules: [rule(), rule()] },
      { rules: [rule({ pattern: 'a*' })] },
      { rules: [rule({ quotable: 'yes' })] },
    ];
    cases.forEach((c, i) => {
      const lex = lexiconFile(c, `invalid-${i}.json`);
      assert.equal(guard(['examples/docs', '--lexicon', lex]).code, 2, JSON.stringify(c));
    });
  });

  test('--json still emits JSON on a usage error', () => {
    const r = ex('examples/docs', '--json', '--bogus');
    assert.equal(r.code, 2);
    const j = JSON.parse(r.stdout);
    assert.equal(j.exitCode, 2);
    assert.match(j.error, /unknown flag/);
  });
});

describe('exit 3', () => {
  test('empty file', () => {
    const r = ex(write('empty/empty.md', ''));
    assert.equal(r.code, 3);
    assert.match(r.stderr, /every file was empty/);
  });

  test('whitespace-only file counts as empty', () => {
    assert.equal(ex(write('blank/blank.md', '  \n\n\t\n')).code, 3);
  });

  test('empty folder', () => {
    const dir = path.join(tmp, 'emptydir');
    fs.mkdirSync(dir, { recursive: true });
    const r = ex(dir);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /no eligible file/);
  });

  test('folder with no eligible file types', () => {
    write('binonly/report.docx', 'Acme Pulse');
    write('binonly/logo.png', 'x');
    assert.equal(ex(path.join(tmp, 'binonly')).code, 3);
  });

  test('one empty file among real files is noted, not fatal', () => {
    const empty = write('mixed/empty.md', '');
    const full = write('mixed/full.md', 'Acme Pulse\n');
    const r = ex(empty, full);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /note: 1 empty file not scanned/);
  });

  test('--json report on exit 3', () => {
    const r = ex(write('empty2/e.txt', ''), '--json');
    assert.equal(r.code, 3);
    const j = JSON.parse(r.stdout);
    assert.equal(j.exitCode, 3);
    assert.equal(j.summary.files, 0);
    assert.equal(j.summary.emptyFiles, 1);
  });
});

describe('quotable', () => {
  test('quotable rule skips double quotes and blockquotes', () => {
    const f = write('q/on.md', [
      'We renamed "Acme Pulse" last year.',
      '> Acme Pulse was the old name.',
      '   > also indented blockquote: Acme Pulse',
      'Curly quotes: “Acme Pulse”.',
    ].join('\n'));
    const r = ex(f, '--json');
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hits.length, 0);
  });

  test('quotable rule still fires on an unquoted occurrence on the same line', () => {
    const f = write('q/mixed.md', 'The "Acme Pulse" name is retired, but Acme Pulse is still on the login page.\n');
    const hits = JSON.parse(ex(f, '--json').stdout).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].column, 39);
  });

  test('unpaired quote does not hide a hit', () => {
    const f = write('q/stray.md', 'He said "the old name is Acme Pulse\n');
    assert.equal(ex(f).code, 1);
  });

  test('non-quotable rule fires inside quotes and blockquotes', () => {
    const f = write('q/off.md', 'The page said "$49/month".\n> $49 per seat\n');
    const r = ex(f, '--json');
    assert.equal(r.code, 1);
    const hits = JSON.parse(r.stdout).hits;
    assert.deepEqual(hits.map((h) => [h.rule, h.line]), [['ADR-011-old-price', 1], ['ADR-011-old-price', 2]]);
  });
});

describe('matching', () => {
  test('one hit per rule per line, case-insensitive', () => {
    const f = write('m/one.md', 'acme pulse, ACME PULSE and Acme  Pulse\nDiscount floor and walk-away price. Do not share externally.\n');
    const hits = JSON.parse(ex(f, '--json').stdout).hits;
    assert.deepEqual(hits.map((h) => [h.rule, h.line]), [['ADR-004-product-name', 1], ['ADR-007-negotiation', 2]]);
  });

  test('lookahead exemption: real-time with a bound passes', () => {
    const f = write('m/rt.md', 'real-time (within 5 seconds)\nreal time under 2s\nrealtime < 3 seconds\n');
    assert.equal(JSON.parse(ex(f, '--json').stdout).hits.length, 0);
  });
});

describe('internalPaths', () => {
  test('client-scoped rules are silent on internal files; all-scoped rules still fire', () => {
    const r = ex('examples/docs', '--json');
    const internal = JSON.parse(r.stdout).hits.filter((h) => h.file.includes('/internal/'));
    assert.deepEqual(internal.map((h) => [h.rule, h.class]), [['ADR-012-terminology', 'internal']]);
  });

  test('every internalPaths pattern classifies a file as internal', () => {
    const text = 'Discount floor is 20%.\n';
    const files = [write('ip/internal/a.md', text), write('ip/drafts/b.md', text), write('ip/c.internal.md', text)];
    const r = ex(path.join(tmp, 'ip'), '--json');
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.files.length, files.length);
    assert.ok(j.files.every((f) => f.class === 'internal'));
  });

  test('paths are matched relative to the scan root folder', () => {
    write('rootcheck/internal/x.md', 'Discount floor is 20%.\n');
    write('rootcheck/public/y.md', 'Discount floor is 20%.\n');
    const hits = JSON.parse(ex(path.join(tmp, 'rootcheck'), '--json').stdout).hits;
    assert.deepEqual(hits.map((h) => h.class), ['client']);
  });

  test('no internalPaths: every file is client-facing', () => {
    const lex = lexiconFile({ rules: [rule({ pattern: 'discount floor', scope: 'client' })] }, 'nopaths.json');
    const r = guard(['examples/docs/internal', '--lexicon', lex, '--json']);
    assert.equal(r.code, 1);
    assert.ok(JSON.parse(r.stdout).files.every((f) => f.class === 'client'));
  });

  test('internal-scoped rules fire only on internal files', () => {
    const lex = lexiconFile({
      internalPaths: ['(^|/)internal/'],
      rules: [rule({ pattern: 'whitelist', scope: 'internal', severity: 'warn' })],
    }, 'internalscope.json');
    const hits = JSON.parse(guard(['examples/docs', '--lexicon', lex, '--json']).stdout).hits;
    assert.deepEqual(hits.map((h) => [h.file, h.class]), [['examples/docs/internal/negotiation.md', 'internal']]);
  });
});

describe('--scope client', () => {
  test('applies client rules to an internal file', () => {
    const file = 'examples/docs/internal/negotiation.md';
    assert.equal(ex(file).code, 0);
    const r = ex(file, '--scope', 'client', '--json');
    assert.equal(r.code, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.scope, 'client');
    const fired = new Set(j.hits.map((h) => h.rule));
    for (const id of ['ADR-007-negotiation', 'ADR-015-sso', 'ADR-002-guarantee']) assert.ok(fired.has(id), id);
  });

  test('human report says the scope was forced', () => {
    assert.match(ex('examples/docs/internal/negotiation.md', '--scope=client').stdout, /1 file scanned as client/);
  });
});

describe('several paths', () => {
  test('files and folders together, flags in any position, duplicates scanned once', () => {
    const r = guard(['--json', 'examples/docs/pricing.md', '--lexicon', EXAMPLE_LEXICON,
      'examples/docs/proposal.md', 'examples/docs', 'examples/docs/pricing.md']);
    assert.equal(r.code, 1);
    const files = JSON.parse(r.stdout).files.map((f) => f.path);
    assert.equal(files.length, 4);
    assert.equal(new Set(files).size, 4);
    assert.deepEqual(files.slice(0, 2), ['examples/docs/pricing.md', 'examples/docs/proposal.md']);
  });

  test('a clean file plus a dirty file fails', () => {
    const clean = write('multi/clean.md', 'All good here.\n');
    assert.equal(ex(clean, 'examples/docs/pricing.md').code, 1);
  });
});

describe('--lexicon default', () => {
  test('reads ./lexicon.json from the working directory', () => {
    const dir = path.join(tmp, 'default-lex');
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'Acme Pulse\n');
    assert.equal(guard(['docs'], { cwd: dir }).code, 2, 'no lexicon.json yet');
    fs.copyFileSync(EXAMPLE_LEXICON, path.join(dir, 'lexicon.json'));
    assert.equal(guard(['docs'], { cwd: dir }).code, 1);
  });
});

describe('output modes', () => {
  test('--quiet prints rule-level summary without file lists', () => {
    const r = ex('examples/docs', '--quiet');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /BLOCKER \[ADR-004-product-name\]  1 hit in 1 file/);
    assert.doesNotMatch(r.stdout, /examples\/docs\//);
    assert.doesNotMatch(r.stdout, /FIX:/);
  });

  test('--json shape', () => {
    const r = ex('examples/docs', '--json');
    assert.equal(r.code, 1);
    assert.equal(r.stderr, '');
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), ['tool', 'version', 'exitCode', 'lexicon', 'scope', 'summary', 'files', 'emptyFiles', 'rules', 'hits']);
    assert.equal(j.tool, 'lexicon-guard');
    assert.equal(j.exitCode, 1);
    assert.equal(j.scope, 'path');
    assert.deepEqual(j.lexicon, {
      path: EXAMPLE_LEXICON, project: 'Acme docs (example)', updated: '2026-10-21', authority: 'DECISIONS.md', rules: 7,
    });
    assert.deepEqual(j.summary, { files: 4, emptyFiles: 0, blockers: 6, warnings: 3 });
    assert.deepEqual(Object.keys(j.files[0]), ['path', 'class']);
    assert.deepEqual(Object.keys(j.rules[0]), ['id', 'decision', 'severity', 'scope', 'message', 'fix', 'hits']);
    assert.equal(j.hits.length, 9);
    const h = j.hits.find((x) => x.rule === 'ADR-004-product-name');
    assert.deepEqual(h, {
      rule: 'ADR-004-product-name',
      severity: 'blocker',
      file: 'examples/docs/pricing.md',
      class: 'client',
      line: 3,
      column: 1,
      match: 'Acme Pulse',
      text: 'Acme Pulse is billed at $49/month per workspace.',
    });
    assert.equal(j.rules.reduce((n, x) => n + x.hits, 0), j.hits.length);
  });
});
