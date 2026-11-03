#!/usr/bin/env node
// lexicon-guard: a deterministic gate for words you have already decided not to use.
// Node 18+, zero dependencies. MIT licensed, see LICENSE.
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.1';

const EXTENSIONS = new Set([
  '.md', '.txt', '.html', '.json', '.yml', '.yaml', '.css',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SEVERITIES = ['blocker', 'warn'];
const RULE_SCOPES = ['all', 'client', 'internal'];
const FORCED_SCOPES = ['client', 'internal'];

const USAGE = `Usage: lexicon-guard <path>... [options]

Scan files and folders against a lexicon of rules. Exits 1 if a blocker is found.

Options:
  --lexicon <file>   Lexicon JSON file (default: ./lexicon.json)
  --scope <scope>    client | internal: classify every file this way instead of by path
  --json             Machine-readable report on stdout
  --quiet            Rule-level summary, no file lists
  -h, --help         Show this help
  -v, --version      Show the version

Exit codes:
  0  clean, or warnings only
  1  at least one blocker
  2  bad usage: unknown flag, missing path, unreadable lexicon, invalid rule or regex
  3  nothing to gate: no eligible file, or every file was empty`;

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const usageError = (message) => new GuardError(2, message);
const toSlash = (p) => p.split(path.sep).join('/');
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { paths: [], lexicon: null, scope: null, json: false, quiet: false, help: false, version: false };
  let flagsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsDone || arg === '-' || !arg.startsWith('-')) {
      opts.paths.push(arg);
      continue;
    }
    if (arg === '--') {
      flagsDone = true;
      continue;
    }

    let name = arg;
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }

    switch (name) {
      case '--lexicon':
      case '--scope': {
        if (value === undefined) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('--')) throw usageError(`${name} needs a value`);
          value = next;
          i++;
        }
        if (value === '') throw usageError(`${name} needs a value`);
        if (name === '--lexicon') opts.lexicon = value;
        else opts.scope = value;
        break;
      }
      case '--json':
      case '--quiet':
      case '--help':
      case '-h':
      case '--version':
      case '-v': {
        if (value !== undefined) throw usageError(`${name} takes no value`);
        if (name === '--json') opts.json = true;
        else if (name === '--quiet') opts.quiet = true;
        else if (name === '--help' || name === '-h') opts.help = true;
        else opts.version = true;
        break;
      }
      default:
        throw usageError(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- lexicon

function compile(pattern, flags, where) {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw usageError(`${where}: invalid regex ${JSON.stringify(pattern)}: ${err.message}`);
  }
}

function loadLexicon(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.message;
    const hint = err.code === 'ENOENT' ? ' (pass --lexicon <file>, or copy lexicon.example.json to lexicon.json)' : '';
    throw usageError(`cannot read lexicon ${label}: ${why}${hint}`);
  }

  let lex;
  try {
    lex = JSON.parse(stripBom(raw));
  } catch (err) {
    throw usageError(`lexicon ${label} is not valid JSON: ${err.message}`);
  }
  if (!lex || typeof lex !== 'object' || Array.isArray(lex)) {
    throw usageError(`lexicon ${label} must be a JSON object`);
  }

  for (const key of ['project', 'updated', 'authority']) {
    if (lex[key] !== undefined && typeof lex[key] !== 'string') {
      throw usageError(`lexicon ${label}: "${key}" must be a string`);
    }
  }

  let internalPaths = [];
  if (lex.internalPaths !== undefined) {
    if (!Array.isArray(lex.internalPaths)) throw usageError(`lexicon ${label}: "internalPaths" must be an array of regexes`);
    internalPaths = lex.internalPaths.map((p, i) => {
      if (typeof p !== 'string' || p === '') throw usageError(`lexicon ${label}: internalPaths[${i}] must be a non-empty string`);
      return compile(p, '', `internalPaths[${i}]`);
    });
  }

  if (!Array.isArray(lex.rules) || lex.rules.length === 0) {
    throw usageError(`lexicon ${label}: "rules" must be a non-empty array`);
  }

  const ids = new Set();
  const rules = lex.rules.map((r, i) => {
    const at = `rule #${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw usageError(`${at}: must be an object`);
    if (typeof r.id !== 'string' || r.id.trim() === '') throw usageError(`${at}: "id" is required`);
    const where = `rule ${r.id}`;
    if (ids.has(r.id)) throw usageError(`${where}: duplicate id`);
    ids.add(r.id);
    if (typeof r.pattern !== 'string' || r.pattern === '') throw usageError(`${where}: "pattern" is required`);
    if (!SEVERITIES.includes(r.severity)) throw usageError(`${where}: "severity" must be one of ${SEVERITIES.join(', ')}`);
    if (!RULE_SCOPES.includes(r.scope)) throw usageError(`${where}: "scope" must be one of ${RULE_SCOPES.join(', ')}`);
    if (r.quotable !== undefined && typeof r.quotable !== 'boolean') throw usageError(`${where}: "quotable" must be true or false`);
    for (const key of ['decision', 'message', 'fix']) {
      if (r[key] !== undefined && typeof r[key] !== 'string') throw usageError(`${where}: "${key}" must be a string`);
    }
    const regex = compile(r.pattern, 'gi', where);
    regex.lastIndex = 0;
    if (regex.test('')) throw usageError(`${where}: pattern matches empty text, so it would fire on every line`);
    return {
      id: r.id,
      decision: r.decision || null,
      severity: r.severity,
      scope: r.scope,
      message: r.message || null,
      fix: r.fix || null,
      quotable: r.quotable === true,
      regex,
    };
  });

  return {
    path: label,
    project: lex.project || null,
    updated: lex.updated || null,
    authority: lex.authority || null,
    internalPaths,
    rules,
  };
}

// ---------------------------------------------------------------- files

function collectFiles(paths, cwd) {
  const files = [];
  const seen = new Set();
  const skipped = [];

  const add = (abs, matchPath) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    files.push({ abs, display: toSlash(path.relative(cwd, abs)) || path.basename(abs), matchPath: toSlash(matchPath) });
  };

  const walk = (dir, root) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw usageError(`cannot read folder ${toSlash(path.relative(cwd, dir)) || '.'}: ${err.message}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs, root);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Follow links to files; never follow links to folders (cycles).
        try {
          isFile = fs.statSync(abs).isFile();
        } catch {
          isFile = false;
        }
      }
      if (isFile && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) add(abs, path.relative(root, abs));
    }
  };

  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw usageError(`path not found: ${p}`);
    }
    if (stat.isDirectory()) {
      walk(abs, abs);
    } else if (stat.isFile() && EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      add(abs, path.relative(cwd, abs));
    } else {
      skipped.push(p);
    }
  }
  return { files, skipped };
}

// ---------------------------------------------------------------- matching

// Spans [open, close] of double-quoted text on one line: straight "..." and curly “...”.
function quoteSpans(line) {
  const spans = [];
  let straight = -1;
  let curly = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (straight < 0) straight = i;
      else {
        spans.push([straight, i]);
        straight = -1;
      }
    } else if (ch === '“') {
      if (curly < 0) curly = i;
    } else if (ch === '”' && curly >= 0) {
      spans.push([curly, i]);
      curly = -1;
    }
  }
  return spans;
}

const insideQuotes = (start, end, spans) => spans.some(([open, close]) => start > open && end <= close);

// First reportable match of a rule on a line, or null. One hit per rule per line.
function firstMatch(rule, line, isBlockquote, getSpans) {
  if (rule.quotable && isBlockquote) return null;
  const re = rule.regex;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (!rule.quotable || !insideQuotes(m.index, m.index + m[0].length, getSpans())) return m;
    re.lastIndex = m.index + 1;
  }
  return null;
}

function scanFile(file, rules) {
  let text;
  try {
    text = fs.readFileSync(file.abs, 'utf8');
  } catch (err) {
    throw usageError(`cannot read ${file.display}: ${err.message}`);
  }
  text = stripBom(text);
  if (text.trim() === '') return { empty: true, hits: [] };

  const hits = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlockquote = /^\s*>/.test(line);
    let spans = null;
    const getSpans = () => (spans === null ? (spans = quoteSpans(line)) : spans);
    for (const rule of rules) {
      const m = firstMatch(rule, line, isBlockquote, getSpans);
      if (m) hits.push({ rule, line: i + 1, column: m.index + 1, match: m[0], text: line });
    }
  }
  return { empty: false, hits };
}

function run(lex, files, forcedScope) {
  const scanned = [];
  const empty = [];
  const hits = [];
  for (const file of files) {
    const cls = forcedScope || (lex.internalPaths.some((re) => re.test(file.matchPath)) ? 'internal' : 'client');
    const rules = lex.rules.filter((r) => r.scope === 'all' || r.scope === cls);
    const result = scanFile(file, rules);
    const entry = { path: file.display, class: cls };
    if (result.empty) {
      empty.push(entry);
      continue;
    }
    scanned.push(entry);
    for (const h of result.hits) hits.push({ ...h, file: file.display, class: cls });
  }
  return { scanned, empty, hits };
}

// ---------------------------------------------------------------- reports

function summarize(lex, outcome) {
  const byRule = lex.rules
    .map((rule) => {
      const ruleHits = outcome.hits.filter((h) => h.rule === rule);
      const files = [];
      for (const h of ruleHits) {
        let f = files.find((x) => x.path === h.file);
        if (!f) files.push((f = { path: h.file, lines: [] }));
        f.lines.push(h.line);
      }
      return { rule, hits: ruleHits.length, files };
    })
    .filter((r) => r.hits > 0);
  const blockers = outcome.hits.filter((h) => h.rule.severity === 'blocker').length;
  const warnings = outcome.hits.length - blockers;
  return { byRule, blockers, warnings };
}

function header(lex, outcome, summary, forcedScope) {
  const first = ['lexicon-guard'];
  if (lex.project) first.push(lex.project);
  if (lex.updated) first.push(`lexicon ${lex.updated}`);
  if (lex.authority) first.push(`authority ${lex.authority}`);
  const scanned = plural(outcome.scanned.length, 'file', 'files') + ' scanned' + (forcedScope ? ` as ${forcedScope}` : '');
  const lines = [first.join(' · '), `${scanned} · ${summary.blockers} BLOCKER · ${summary.warnings} warn`];
  if (outcome.empty.length) {
    lines.push(`note: ${plural(outcome.empty.length, 'empty file', 'empty files')} not scanned: ${outcome.empty.map((e) => e.path).join(', ')}`);
  }
  return lines;
}

function verdict(summary) {
  const blockerRules = summary.byRule.filter((r) => r.rule.severity === 'blocker').length;
  if (summary.blockers) {
    return `RESULT: FAIL · ${plural(summary.blockers, 'blocker hit', 'blocker hits')} from ${plural(blockerRules, 'rule', 'rules')}`;
  }
  if (summary.warnings) return `RESULT: PASS · ${plural(summary.warnings, 'warning', 'warnings')}, no blockers`;
  return 'RESULT: PASS · clean';
}

function ruleTitle(r) {
  return `[${r.rule.id}]  ${plural(r.hits, 'hit', 'hits')}` + (r.rule.decision ? `  · enforces ${r.rule.decision}` : '');
}

function formatHuman(lex, outcome, summary, forcedScope) {
  const out = header(lex, outcome, summary, forcedScope);
  const sections = [
    ['━━ BLOCKERS ━━', summary.byRule.filter((r) => r.rule.severity === 'blocker')],
    ['━━ WARNINGS ━━', summary.byRule.filter((r) => r.rule.severity === 'warn')],
  ];
  for (const [title, rules] of sections) {
    if (!rules.length) continue;
    out.push('', title);
    for (const r of rules) {
      out.push('', ruleTitle(r));
      if (r.rule.message) out.push(`  ${r.rule.message}`);
      if (r.rule.fix) out.push(`  FIX: ${r.rule.fix}`);
      for (const f of r.files) {
        out.push(`    ${f.path}  (${f.lines.length})  ${f.lines.length === 1 ? 'line' : 'lines'} ${f.lines.join(', ')}`);
      }
    }
  }
  out.push('', verdict(summary));
  return out.join('\n');
}

function formatQuiet(lex, outcome, summary, forcedScope) {
  const out = header(lex, outcome, summary, forcedScope);
  if (summary.byRule.length) out.push('');
  for (const r of summary.byRule) {
    const label = r.rule.severity === 'blocker' ? 'BLOCKER' : 'warn   ';
    out.push(`${label} [${r.rule.id}]  ${plural(r.hits, 'hit', 'hits')} in ${plural(r.files.length, 'file', 'files')}` +
      (r.rule.decision ? `  · enforces ${r.rule.decision}` : ''));
  }
  out.push('', verdict(summary));
  return out.join('\n');
}

function jsonReport(lex, outcome, summary, forcedScope, exitCode, error) {
  const report = {
    tool: 'lexicon-guard',
    version: VERSION,
    exitCode,
    lexicon: {
      path: lex.path,
      project: lex.project,
      updated: lex.updated,
      authority: lex.authority,
      rules: lex.rules.length,
    },
    scope: forcedScope || 'path',
    summary: {
      files: outcome.scanned.length,
      emptyFiles: outcome.empty.length,
      blockers: summary.blockers,
      warnings: summary.warnings,
    },
    files: outcome.scanned,
    emptyFiles: outcome.empty,
    rules: summary.byRule.map((r) => ({
      id: r.rule.id,
      decision: r.rule.decision,
      severity: r.rule.severity,
      scope: r.rule.scope,
      message: r.rule.message,
      fix: r.rule.fix,
      hits: r.hits,
    })),
    hits: outcome.hits.map((h) => ({
      rule: h.rule.id,
      severity: h.rule.severity,
      file: h.file,
      class: h.class,
      line: h.line,
      column: h.column,
      match: h.match,
      text: h.text,
    })),
  };
  if (error) report.error = error;
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------- main

function main(argv, cwd, stdout, stderr) {
  const wantJson = argv.includes('--json');
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout(USAGE);
      return 0;
    }
    if (opts.version) {
      stdout(VERSION);
      return 0;
    }
    if (opts.scope !== null && !FORCED_SCOPES.includes(opts.scope)) {
      throw usageError(`--scope must be one of ${FORCED_SCOPES.join(', ')} (got ${JSON.stringify(opts.scope)})`);
    }
    if (opts.paths.length === 0) throw usageError('missing path: give at least one file or folder to scan');

    const lexLabel = opts.lexicon || 'lexicon.json';
    const lex = loadLexicon(path.resolve(cwd, lexLabel), lexLabel);
    const { files, skipped } = collectFiles(opts.paths, cwd);
    const outcome = run(lex, files, opts.scope);
    const summary = summarize(lex, outcome);

    if (outcome.scanned.length === 0) {
      let why;
      if (files.length === 0) {
        why = 'no eligible file in ' + opts.paths.join(', ');
        if (skipped.length) why += ` (not a text type it reads: ${skipped.join(', ')}; extract to text first)`;
      } else {
        why = `every file was empty (${plural(files.length, 'file', 'files')})`;
      }
      stderr(`lexicon-guard: nothing to gate: ${why}`);
      if (opts.json) stdout(jsonReport(lex, outcome, summary, opts.scope, 3, `nothing to gate: ${why}`));
      return 3;
    }

    const exitCode = summary.blockers > 0 ? 1 : 0;
    if (opts.json) stdout(jsonReport(lex, outcome, summary, opts.scope, exitCode));
    else if (opts.quiet) stdout(formatQuiet(lex, outcome, summary, opts.scope));
    else stdout(formatHuman(lex, outcome, summary, opts.scope));
    return exitCode;
  } catch (err) {
    const known = err instanceof GuardError;
    const message = known ? err.message : `unexpected error: ${err && err.stack ? err.stack : err}`;
    stderr(`lexicon-guard: ${message}`);
    if (known && !argv.includes('--help') && !argv.includes('-h')) stderr('Run with --help for usage.');
    if (wantJson) {
      stdout(JSON.stringify({ tool: 'lexicon-guard', version: VERSION, exitCode: 2, error: message }, null, 2));
    }
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(
    process.argv.slice(2),
    process.cwd(),
    (s) => process.stdout.write(s + '\n'),
    (s) => process.stderr.write(s + '\n'),
  );
}

module.exports = { main, VERSION };
