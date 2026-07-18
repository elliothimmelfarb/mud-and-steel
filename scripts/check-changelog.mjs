#!/usr/bin/env node
/**
 * Changelog gate — fails when game code changes without a war-record entry.
 *
 * Rule: if the diff against the base branch touches src/ or api/, it must
 * also touch src/ui/changelog.ts. Keeps the Despatches panel on the title
 * screen honest — the record can never silently go stale.
 *
 * Escape hatch: include "[skip changelog]" in any commit message in the
 * range (for pure refactors with zero player-visible effect).
 *
 * Runs in CI on pull requests (BASE_REF set by the workflow) and locally
 * via `npm run check:changelog` (diffs against origin/main or main).
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

function resolveBase() {
  const ref = process.env.BASE_REF
  const candidates = ref ? [`origin/${ref}`, ref] : ['origin/main', 'main']
  for (const c of candidates) {
    try {
      sh(`git rev-parse --verify --quiet ${c}`)
      return c
    } catch {
      /* try next */
    }
  }
  throw new Error('changelog gate: could not resolve a base branch to diff against')
}

const base = resolveBase()
const mergeBase = sh(`git merge-base ${base} HEAD`)
const changed = sh(`git diff --name-only ${mergeBase} HEAD`).split('\n').filter(Boolean)

const CHANGELOG = 'src/ui/changelog.ts'
const touchesGame = changed.some((f) => (f.startsWith('src/') || f.startsWith('api/')) && f !== CHANGELOG)
const touchesChangelog = changed.includes(CHANGELOG)

if (!touchesGame) {
  console.log('changelog gate: no src/ or api/ changes — nothing to record.')
  process.exit(0)
}

if (!touchesChangelog) {
  const skips = sh(`git log --format=%B ${mergeBase}..HEAD`)
  if (skips.includes('[skip changelog]')) {
    console.log('changelog gate: skipped via [skip changelog] commit trailer.')
    process.exit(0)
  }
  console.error(
    `changelog gate: this change touches src/ or api/ but not ${CHANGELOG}.\n` +
      'Add an entry to the war record (or extend the top entry) so the\n' +
      'Despatches panel stays true. For changes with zero player-visible\n' +
      'effect, include "[skip changelog]" in a commit message.',
  )
  process.exit(1)
}

// Light sanity checks on the file itself so a placeholder edit can't pass.
const src = readFileSync(CHANGELOG, 'utf8')
const versions = [...src.matchAll(/version:\s*'([^']+)'/g)].map((m) => m[1])
const dates = [...src.matchAll(/date:\s*'([^']+)'/g)].map((m) => m[1])

if (versions.length === 0) {
  console.error('changelog gate: no entries found in the changelog.')
  process.exit(1)
}
if (new Set(versions).size !== versions.length) {
  console.error('changelog gate: duplicate version strings in the changelog.')
  process.exit(1)
}
const badDate = dates.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))
if (badDate) {
  console.error(`changelog gate: bad date "${badDate}" — use YYYY-MM-DD.`)
  process.exit(1)
}

console.log(`changelog gate: ok — top entry v${versions[0]} (${dates[0]}).`)
