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
 * 2. Spawn `k` parallel chains. Each chain performs:
 *    - Generate an answer.
 *    - Critique the answer and assign a score.
 *    - If score < threshold, revise the answer and repeat (limited passes).
 * 3. Stream a short summary of the first chain's reasoning so the user sees
 *    progress immediately.
 * 4. Select the top three scored answers and ask Grok to craft a final reply.
 * 5. Optionally append the final answer to the input file.
 */

import { generateText, streamText } from 'ai'
import { xai } from '@ai-sdk/xai'
import { SingleBar, Presets } from 'cli-progress'
import * as fs from 'node:fs/promises'

// How many critique/revision passes to attempt per candidate
const MAX_PASSES = 3
// Minimum score (1-10 scale) required to stop revising
const MIN_SCORE = 7

type ScoredResult = { answer: string; score: number }

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

/**
 * Generate, critique and optionally revise a candidate answer.
 */
async function runChain(
  question: string,
  systemPrompt: string,
  bar: SingleBar,
  index: number,
): Promise<ScoredResult> {
  // Initial answer
  const first = await generateText({
    model: xai('grok-3-mini'),
    prompt: `Q: ${question}\nA:\nThink deeply about this and reason from first principles.`,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'high' } },
  })
  let answer = first.text.trim()
  let rationale = (first.reasoning ?? '').trim()
  bar.increment()

  // Stream summary for the first chain so the user gets immediate feedback
  if (index === 0 && rationale) {
    await streamReasoningSummary(rationale)
    bar.increment()
  }

  let score = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Critique step
    const critiqueRes = await generateText({
      model: xai('grok-3-mini'),
      prompt: `Question: ${question}\n\nAnswer:\n${answer}\n\nProvide a short critique and rate the answer from 1 to 10. Use the form:\nScore: <number>\nCritique: <text>`,
      temperature: 0,
      system: systemPrompt || undefined,
      providerOptions: { xai: { reasoningEffort: 'low' } },
    })
    const critique = critiqueRes.text.trim()
    const m = critique.match(/score\s*:\s*(\d+)/i)
    score = m ? Number(m[1]) : 0
    bar.increment()

    if (score >= MIN_SCORE || pass === MAX_PASSES - 1) {
      break
    }

    // Revision step
    const revision = await generateText({
      model: xai('grok-3-mini'),
      prompt: `Original question: ${question}\n\nCurrent answer:\n${answer}\n\nCritique:\n${critique}\n\nRevise the answer to address the critique. Respond with the improved answer only.`,
      temperature: 1,
      system: systemPrompt || undefined,
      providerOptions: { xai: { reasoningEffort: 'high' } },
    })
    answer = revision.text.trim()
    bar.increment()
  }

  return { answer, score }
}

/** Main entry */
async function main() {
  const [, , ...cli] = process.argv

  // --- Argument parsing ----------------------------------------------------
  let questionArg: string | undefined
  let k = 9
  let filePath = ''
  let systemPath = ''

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

  console.log(`\nQuery: ${question.slice(0, 20)}${question.length > 20 ? '…' : ''}`)
  console.log(`Sampling ${k} variants …\n`)

  // Progress bar estimates the worst case (initial answer + critique + revision per pass)
  const bar = new SingleBar(
    { clearOnComplete: true, hideCursor: true },
    Presets.shades_classic,
  )
  bar.start(k * (1 + MAX_PASSES * 2) + 2, 0)

  // Launch k parallel self-critique chains
  const tasks: Promise<ScoredResult>[] = Array.from({ length: k }).map((_, i) =>
    runChain(question, systemPrompt, bar, i),
  )

  const results = await Promise.all(tasks)

  // Pick the top three answers by score
  const topThree = results
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.answer)

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

  const deliberationContext = topThree
    .map((a, idx) => `${idx + 1}. ${a}`)
    .join('\n')

  const finalPrompt = `Original question:\n${question}\n\nCandidate answers (for internal use only):\n${deliberationContext}\n\nPlease provide the best possible answer to the original question. Respond with the answer only and do not mention or reference the candidate answers.`

  const finalStream = await streamText({
    model: xai('grok-3-mini'),
    prompt: finalPrompt,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'high' } },
  })

  let ensembleAnswer = ''
  for await (const chunk of finalStream.textStream) {
    process.stdout.write(chunk)
    ensembleAnswer += chunk
  }
  console.log() // newline after streaming final answer

  const ensembleRationale = ((await finalStream.reasoning) ?? '').trim()

  if (ensembleRationale) {
    console.log('--- Grok 3 Final Reasoning ---')
    console.log(ensembleRationale)
    console.log('---------------------------------\n')
  }

  console.log('\nFinal answer:', ensembleAnswer.trim())

  // Append answer (and reasoning) back to the file if file-mode is enabled
  if (usingFile) {
    let append = `\n\n--- Grok 3 Answer (${new Date().toLocaleString()}) ---\n${ensembleAnswer.trim()}\n`
    if (ensembleRationale) {
      append += `\n--- Grok 3 Reasoning ---\n${ensembleRationale}\n`
    }
    await fs.appendFile(filePath, append, 'utf8')
    console.log(`\nAppended final answer to '${filePath}'.`)
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
