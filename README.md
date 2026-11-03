# lexicon-guard

A deterministic gate for words you have already decided not to use.

Teams make decisions about language all the time: a product gets renamed, a price is retired, a feature is "on the roadmap" and not "available", a negotiating number must never reach a customer. The decision gets made once. The old words keep coming back: someone copies a paragraph from an old deck, a retired price gets corrected in most places and survives in one, an internal note gets pasted into a customer email.

Those recurrences are not a judgment problem. They are a grep problem. lexicon-guard greps a file or a folder against a lexicon of rules, each rule citing the decision it enforces, and exits non-zero when a blocker is found. It runs in milliseconds, has no dependencies, makes no network calls and calls no model.

## How it works

- A **lexicon** is a JSON file of rules. Each rule is a case-insensitive regular expression plus the decision behind it, why it exists and what to write instead.
- Every scanned file is classified **client** or **internal** from its path. Rules scoped `client` fire only on client-facing files; rules scoped `all` fire everywhere.
- Rules marked **quotable** skip hits inside a markdown blockquote or inside double quotes, so a document that *fixes* a banned term can still name it.
- One hit per rule per line. The line is the unit of repair.
- **Empty input fails.** A run that found no text to scan exits 3, never 0, so a broken extraction step cannot pass as a clean document.

## Quick start

Requires Node 18 or later. No install step.

```bash
git clone https://github.com/TrolixC/lexicon-guard
cd lexicon-guard
node guard.js examples/docs --lexicon lexicon.example.json
```

```
lexicon-guard · Acme docs (example) · lexicon 2026-10-21 · authority DECISIONS.md
4 files scanned · 6 BLOCKER · 3 warn

━━ BLOCKERS ━━

[ADR-004-product-name]  1 hit  · enforces ADR-004
  The product was renamed. The old name still ranks in search, and buyers comparing quotes think they are two products.
  FIX: "Acme Signals".
    examples/docs/pricing.md  (1)  line 3

[ADR-011-old-price]  1 hit  · enforces ADR-011
  Retired list price. It still survives on old pages; a customer who quotes it expects it honored.
  FIX: Link to the pricing page. Do not restate a figure in prose.
    examples/docs/pricing.md  (1)  line 3

[ADR-007-negotiation]  1 hit  · enforces ADR-007
  Negotiation logic on a customer-facing page.
  FIX: Move it under internal/. Not quotable on purpose: a leak inside quotation marks is still a leak.
    examples/docs/proposal.md  (1)  line 4

[ADR-015-sso]  1 hit  · enforces ADR-015
  SSO is on the roadmap, not in the product. A security reviewer will treat this sentence as a commitment.
  FIX: "SSO is on the roadmap." No date.
    examples/docs/pricing.md  (1)  line 5

[ADR-002-guarantee]  2 hits  · enforces ADR-002
  Contract language. Only the SLA makes commitments.
  FIX: "designed for" or "targets", and link the SLA.
    examples/docs/overview.md  (1)  line 8
    examples/docs/pricing.md  (1)  line 4

━━ WARNINGS ━━

[ADR-009-realtime]  1 hit  · enforces ADR-009
  Ambiguous. Engineering means under five seconds; buyers hear instant. Warn, not blocker: some uses are fine, so read the sentence.
  FIX: State the bound: "real-time (within 5 seconds)".
    examples/docs/overview.md  (1)  line 6

[ADR-012-terminology]  2 hits  · enforces ADR-012
  Retired terminology.
  FIX: "allowlist" / "blocklist".
    examples/docs/internal/negotiation.md  (1)  line 7
    examples/docs/overview.md  (1)  line 7

RESULT: FAIL · 6 blocker hits from 5 rules
```

To gate your own docs, copy `lexicon.example.json` to `lexicon.json`, replace the rules with your own, and point the guard at whatever is about to leave:

```bash
node guard.js docs/                          # whole folder, path-based scopes
node guard.js outbound/proposal.md --scope client   # one file, strictest reading
node guard.js notes/ --scope internal         # treat every file as internal, whatever its path
node guard.js a.md b.md c.md                 # several paths (what a pre-commit hook passes)
node guard.js docs/ --quiet                  # rule-level summary, no file lists
node guard.js docs/ --json > report.json     # machine-readable
```

`--lexicon` defaults to `./lexicon.json`. Use `--scope client` on anything about to be sent: it applies client rules regardless of where the file sits.

`--json` prints one object: `exitCode`, `lexicon`, `scope`, `summary` (`files`, `emptyFiles`, `blockers`, `warnings`), `files` (each with its `class`), `rules` that fired, and `hits`, each with `rule`, `severity`, `file`, `class`, `line`, `column`, `match` and the line's `text`. On exit 2 or 3 it still prints an object, with an `error` field.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| 0 | Clean, or warnings only |
| 1 | At least one blocker |
| 2 | Bad usage: unknown flag, missing path, unreadable lexicon, invalid rule or regex |
| 3 | Nothing to gate: no eligible file, or every file was empty |

## The lexicon

```json
{
  "project": "Acme docs (example)",
  "updated": "2026-10-21",
  "authority": "DECISIONS.md",
  "internalPaths": ["(^|/)internal/", "(^|/)drafts/", "\\.internal\\.md$"],
  "rules": [
    {
      "id": "ADR-004-product-name",
      "decision": "ADR-004",
      "severity": "blocker",
      "scope": "all",
      "pattern": "\\bacme\\s+pulse\\b",
      "message": "The product was renamed. The old name still ranks in search, and buyers comparing quotes think they are two products.",
      "fix": "\"Acme Signals\".",
      "quotable": true
    }
  ]
}
```

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `id` | yes | Unique rule name, shown in the report |
| `pattern` | yes | JavaScript regex, applied case-insensitively to each line |
| `severity` | yes | `blocker` fails the run; `warn` reports and passes |
| `scope` | yes | `all`, `client` or `internal` |
| `decision` | strongly advised | The decision record the rule enforces (an ADR, a ticket, a line in a decisions file) |
| `message` | strongly advised | Why the rule exists, ideally in the words of whoever objected |
| `fix` | strongly advised | What to write instead. A gate that reports a problem without the answer just moves the work |
| `quotable` | no | Skip hits inside quotes or blockquotes. Leave it off for leaks and wrong figures, which are wrong in quotes too |

Top-level `internalPaths` is a list of regexes matched against each file's path relative to the scan root: the folder you passed, or the current directory for a file you passed by name. A match makes the file internal; everything else is client-facing. With no `internalPaths`, every file is client-facing, so the guard reads strictly by default.

`lexicon.example.json` has seven rules for a fictional company that show each pattern worth copying: a renamed product, a retired price, negotiation language that must stay internal, a roadmap feature described as shipped, contract language, an ambiguous term with a lookahead exemption ("real-time" passes when a bound follows it), and retired terminology.

### Writing rules that last

- **Decision first, rule second.** A rule enters the lexicon only after the decision exists somewhere people can read it. If a rule fires wrongly, fix the decision record, then the rule. A lexicon that drifts from its decisions teaches people to ignore the output.
- **Blocker for anything a customer can act on.** Prices, commitments, leaks. Put vocabulary drift in `warn`.
- **Exclude by path, not by weakening the pattern.** Your decisions file quotes every banned term by definition. Put it under an internal path rather than loosening the regex.
- **Test the pattern against your own markup.** A bare word like `float` will match every CSS file you own. Scope it, or make it a phrase.

## Pre-commit

**With the [pre-commit](https://pre-commit.com) framework:**

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/TrolixC/lexicon-guard
    rev: v1.0.1
    hooks:
      - id: lexicon-guard
        args: [--lexicon, lexicon.json]
```

**As a plain git hook** (vendor `guard.js` into `tools/lexicon-guard/`):

```sh
#!/bin/sh
# .git/hooks/pre-commit
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.md' '*.txt' '*.html')
[ -z "$files" ] && exit 0
exec node tools/lexicon-guard/guard.js $files --lexicon lexicon.json
```

The plain hook checks the working-tree copy of each staged file and splits on whitespace, so it does not handle filenames with spaces. The pre-commit framework handles both.

## CI

```yaml
# .github/workflows/lexicon.yml
name: lexicon
on: [pull_request]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node tools/lexicon-guard/guard.js docs --lexicon lexicon.json
```

A blocker fails the job. Add `--json > lexicon-report.json` and upload it as an artifact if you want the hits outside the log.

## Why deterministic, and why no model

Language models are good at finding problems nobody has named yet. That is the expensive part of reviewing a document set, and it is worth paying for once. After that, most defects are not new: they are decisions already made, leaking back in. Using a model to catch those is paying for judgment on a question that no longer needs it.

A deterministic gate has properties a model review cannot give you:

- **The same input gives the same answer.** A gate that passes a file on Tuesday and blocks it on Wednesday, with nothing changed, gets switched off.
- **Every hit is explainable.** The report names the rule, the decision behind it and the fix. Nobody argues with a regex about tone.
- **It costs nothing to run, so it runs everywhere.** Every commit, every send, every CI job. A gate you have to remember to run, or budget for, stops running.
- **It works offline and sends nothing anywhere.** The documents you most need to gate are often the ones you least want to send to a third party.

The trade is that it only knows what you told it. A decision that never became a rule is invisible to it. Use model review to find new problems, and turn the ones you rule on into lexicon entries so they never cost a model call again.

## Limits

- **Text only.** It reads `.md`, `.txt`, `.html`, `.json`, `.yml`/`.yaml`, `.css` and JS/TS files, and skips `.git` and `node_modules` when walking a folder. For Word or PDF, extract to text first (`pandoc -t gfm --wrap=none`, `pdftotext -layout`) and gate the extract. Gating only a markdown mirror is how a hand-edited `.docx` gets through.
- **Regex, not comprehension.** It cannot tell a live sentence from a quotation it was not told about, and it cannot see meaning that spans lines.
- **Line by line.** A claim split across two lines, or a label on one line and its value on the next, is invisible.
- **Old documents will light up, correctly.** Archives contain the old vocabulary by definition. Gate what you are sending, not the archive.

## Tests

```bash
npm test
```

Runs `node --test` against the example lexicon, the fixtures in `examples/` and temporary files for edge cases. One test checks that the sample output above is still what the example run prints. No dependencies to install.

## License

MIT. See `LICENSE`.
