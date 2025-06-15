#!/usr/bin/env ts-node

import * as fs from 'node:fs/promises'
// import * as path from 'node:path'

/**
 * fix-citations.ts
 * -----------------
 * Replace OpenAI-style `[oai_citation:N‡label](url)` references with plain
 * Markdown numeric citations `[N]` and append a footnote link reference list
 * at the end of the document:
 *     [N]: url
 *
 * Usage examples:
 *   ts-node fix-citations.ts README.md            # prints transformed file
 *   ts-node fix-citations.ts README.md --write    # edits file in-place
 */

async function main() {
  const [, , ...cli] = process.argv
  if (cli.length === 0) {
    console.error('Usage: fix-citations.ts <file> [--write]')
    process.exit(1)
  }

  const filePath = cli[0]
  const writeInPlace = cli.includes('--write')

  const raw = await fs.readFile(filePath, 'utf8')

  // Regex to match `[oai_citation:N‡label](url)`
  const citationRe = /\[oai_citation:(\d+)‡[^\]]*\]\(([^)]+)\)/g

  const citations: Record<string, string> = {}
  let replaced = raw.replace(citationRe, (_, num: string, url: string) => {
    // If same number appears with different URL, keep first seen URL
    if (!(num in citations)) {
      citations[num] = url
    }
    return `[${num}]`
  })

  // If no citations found, just emit original content
  if (Object.keys(citations).length === 0) {
    console.log(raw)
    return
  }

  // Remove any existing footnotes of the form `[num]: url` at end
  replaced = replaced.replace(/\n\[\d+\]:\s+https?:[^\n]+/g, '')
  replaced = replaced.trimEnd() + '\n\n'

  // Append footnotes sorted by numeric key
  const entries = Object.entries(citations).sort((a, b) => Number(a[0]) - Number(b[0]))
  for (const [num, url] of entries) {
    replaced += `[${num}]: ${url}\n`
  }

  if (writeInPlace) {
    await fs.writeFile(filePath, replaced)
  } else {
    process.stdout.write(replaced)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
}) 