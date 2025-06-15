#!/usr/bin/env ts-node

// Minimal subset of Node globals for this standalone script
declare const process: {
  argv: string[]
  exit: (code?: number) => void
  stdout: { write: (chunk: string) => void }
}

/**
 * grok3-pro.ts
 *
 * @deprecated Use grok3-ink.tsx instead.
 *
 * Usage:
 *   XAI_API_KEY="your_api_key" ts-node grok3-pro.ts "Your question" [k]
 *   XAI_API_KEY="your_api_key" ts-node grok3-pro.ts --file path/to/file.txt [k]
 *   XAI_API_KEY="your_api_key" ts-node grok3-pro.ts --system system.txt "Your question"
 *
 * `k` = number of parallel samples (default: 5)
 */

/**
 * Algorithm overview
 * ------------------
 * 1. Parse CLI flags and build a question prompt.
 * 2. Run a Tree of Thought search with `k` parallel chains. Each chain uses
 *    Monte Carlo Tree Search style exploration to critique and refine answers.
 * 3. Stream a short summary of the first chain's reasoning so the user sees
 *    progress immediately.
 * 4. Select the top three scored answers and ask Grok to craft a final reply.
 * 5. Optionally append the final answer to the input file.
 */

import { streamText } from 'ai'
import { xai } from '@ai-sdk/xai'
import { SingleBar, Presets } from 'cli-progress'
import * as fs from 'node:fs/promises'
import {
  treeOfThoughtSearch,
  finalAggregation,
  MAX_PASSES,
  type ScoredResult,
} from '../src/tot.js'

// Constants and result type imported from the algorithm module

/**
 * Summarize reasoning into short themed blocks with bold headers.
 */
async function streamReasoningSummary(reasoning: string) {
  const summary = await streamText({
    model: xai('grok-3-mini'),
    prompt:
      'Summarize the following reasoning. Use bold headers of 5-7 words and 2-3 sentences per block.\n\n' +
      reasoning,
    temperature: 0.2,
    providerOptions: { xai: { reasoningEffort: 'low' } },
  })
  for await (const chunk of summary.textStream) {
    process.stdout.write(chunk)
  }
  console.log()
}

/** Main entry */
async function main() {
  const [, , ...cli] = process.argv

  // --- Argument parsing ----------------------------------------------------
  let questionArg: string | undefined
  let k = 9
  let filePath = ''
  let systemPath = ''
  let debug = false

  for (let i = 0; i < cli.length; i++) {
    const arg = cli[i]
    if (arg === '--file' || arg === '-f') {
      filePath = cli[i + 1]
      if (!filePath) {
        throw new Error('--file flag requires a path argument')
      }
      i++ // skip file path in next loop iteration
    } else if (arg === '--system' || arg === '-s') {
      systemPath = cli[i + 1]
      if (!systemPath) {
        throw new Error('--system flag requires a path argument')
      }
      i++
    } else if (arg === '--debug' || arg === '-d') {
      debug = true
    } else if (questionArg === undefined) {
      questionArg = arg
    } else if (!Number.isNaN(Number(arg))) {
      k = Number(arg)
    }
  }

  let question: string
  const usingFile = filePath !== ''

  if (usingFile) {
    // Read question from file
    question = (await fs.readFile(filePath, 'utf8')).trim()
    if (!question) {
      throw new Error(
        `File '${filePath}' is empty – cannot derive question text`,
      )
    }
  } else {
    question = questionArg ?? 'What is 101*3?'
  }

  // Resolve system prompt ---------------------------------------------------
  let systemPrompt = ''
  try {
    // If the user specified a path, use it. Otherwise default to ./system.txt if it exists
    const candidate = systemPath || 'system.txt'
    if (candidate) {
      systemPrompt = (await fs.readFile(candidate, 'utf8')).trim()
      if (systemPrompt) {
        console.log(`Loaded system prompt from '${candidate}'.`)
      }
    }
  } catch {
    // ignore if file not found
  }

  console.log(
    `\nQuery: ${question.slice(0, 20)}${question.length > 20 ? '…' : ''}`,
  )
  console.log(`Sampling ${k} variants …\n`)

  let debugLog: ((msg: string) => Promise<void>) | undefined
  if (debug) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const debugPath = `debug-${ts}.log`
    debugLog = async (m: string) => {
      await fs.appendFile(debugPath, m + '\n', 'utf8')
    }
    console.log(`Debug output -> ${debugPath}`)
    await fs.writeFile(debugPath, `Query: ${question}\n`, 'utf8')
    if (systemPrompt) {
      await fs.appendFile(debugPath, `System prompt: ${systemPrompt}\n`, 'utf8')
    }
  }

  // Progress bar estimates the worst case (initial answer + critique + revision per pass)
  const bar = new SingleBar(
    { clearOnComplete: true, hideCursor: true },
    Presets.shades_classic,
  )
  bar.start(k * (1 + MAX_PASSES * 2) + 2, 0)

  // Launch k parallel Tree of Thought chains
  const results = await treeOfThoughtSearch(
    question,
    systemPrompt,
    k,
    bar,
    MAX_PASSES,
    debugLog,
  )

  if (results[0]?.rationale) {
    await streamReasoningSummary(results[0].rationale)
    bar.increment()
  }

  // Pick the top three answers by score
  const topThree = results
    .sort((a: ScoredResult, b: ScoredResult) => b.score - a.score)
    .slice(0, 3)
    .map((r: ScoredResult) => r.answer)

  if (topThree.length === 0) {
    console.log('No answers were produced.')
    bar.stop()
    return
  }

  // =============================================================
  // Craft a final prompt using the best-scored answers.
  // =============================================================

  console.log(
    `\nGenerating final answer based on top ${topThree.length} candidates …\n`,
  )

  const { answer: ensembleAnswer, reasoning: ensembleRationale } =
    await finalAggregation(question, topThree, systemPrompt, debugLog)

  if (ensembleRationale) {
    console.log('--- Grok 3 Final Reasoning ---')
    console.log(ensembleRationale)
    console.log('---------------------------------\n')
  }

  console.log('\nFinal answer:', ensembleAnswer)
  if (debugLog) {
    await debugLog(`Final reasoning: ${ensembleRationale}`)
    await debugLog(`Final answer: ${ensembleAnswer}`)
  }

  // Append answer (and reasoning) back to the file if file-mode is enabled
  if (usingFile) {
    let append = `\n\n--- Grok 3 Answer (${new Date().toLocaleString()}) ---\n${ensembleAnswer.trim()}\n`
    if (ensembleRationale) {
      append += `\n--- Grok 3 Reasoning ---\n${ensembleRationale}\n`
    }
    await fs.appendFile(filePath, append, 'utf8')
    console.log(`\nAppended final answer to '${filePath}'.`)
    if (debugLog) {
      await debugLog(`Appended answer to file: ${filePath}`)
    }
  }

  // Mark final deliberation step complete in progress bar
  bar.increment()
  // Adjust total to reflect actual work in case chains finished early
  bar.setTotal((bar as any).value)
  bar.stop()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
