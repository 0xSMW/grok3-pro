// Tree of Thought algorithm utilities
import { generateText, streamText } from 'ai'
import { xai } from '@ai-sdk/xai'
import { SingleBar } from 'cli-progress'

export const MAX_PASSES = 3
export const MIN_SCORE = 7

export type ScoredResult = { answer: string; score: number; rationale?: string }

async function critiqueAnswer(
  question: string,
  answer: string,
  systemPrompt: string,
): Promise<{ score: number; critique: string }> {
  const res = await generateText({
    model: xai('grok-3-mini'),
    prompt: `Question: ${question}\n\nAnswer:\n${answer}\n\nProvide a short critique and rate the answer from 1 to 10. Use the form:\nScore: <number>\nCritique: <text>`,
    temperature: 0,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'low' } },
  })
  const text = res.text.trim()
  const m = text.match(/score\s*:\s*(\d+)/i)
  const score = m ? Number(m[1]) : 0
  return { score, critique: text }
}

async function reviseAnswer(
  question: string,
  answer: string,
  critique: string,
  systemPrompt: string,
): Promise<string> {
  const res = await generateText({
    model: xai('grok-3-mini'),
    prompt: `Original question: ${question}\n\nCurrent answer:\n${answer}\n\nCritique:\n${critique}\n\nRevise the answer to address the critique. Respond with the improved answer only.`,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'high' } },
  })
  return res.text.trim()
}

async function initialAnswer(
  question: string,
  systemPrompt: string,
): Promise<{ answer: string; rationale: string }> {
  const res = await generateText({
    model: xai('grok-3-mini'),
    prompt: `Q: ${question}\nA:\nThink deeply about this and reason from first principles.`,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'high' } },
  })
  return { answer: res.text.trim(), rationale: (res.reasoning ?? '').trim() }
}

export async function runMCTSChain(
  question: string,
  systemPrompt: string,
  bar: SingleBar,
  depth = MAX_PASSES,
  debugLog?: (msg: string) => Promise<void>,
): Promise<ScoredResult> {
  const first = await initialAnswer(question, systemPrompt)
  let answer = first.answer
  let score = 0
  if (debugLog) {
    await debugLog(`Initial answer: ${answer}`)
    if (first.rationale) await debugLog(`Rationale: ${first.rationale}`)
  }
  for (let d = 0; d < depth; d++) {
    const { score: s, critique } = await critiqueAnswer(
      question,
      answer,
      systemPrompt,
    )
    score = s
    if (debugLog) {
      await debugLog(`Pass ${d + 1} critique (score ${score}): ${critique}`)
    }
    bar.increment()
    if (score >= MIN_SCORE || d === depth - 1) break
    answer = await reviseAnswer(question, answer, critique, systemPrompt)
    if (debugLog) {
      await debugLog(`Pass ${d + 1} revised answer: ${answer}`)
    }
    bar.increment()
  }
  if (debugLog) await debugLog(`Final chain answer (score ${score}): ${answer}`)
  return { answer, score, rationale: first.rationale }
}

export async function treeOfThoughtSearch(
  question: string,
  systemPrompt: string,
  k: number,
  bar: SingleBar,
  depth = MAX_PASSES,
  debugLog?: (msg: string) => Promise<void>,
): Promise<ScoredResult[]> {
  const tasks = Array.from({ length: k }).map((_, idx) =>
    runMCTSChain(
      question,
      systemPrompt,
      bar,
      depth,
      debugLog ? (m) => debugLog(`[chain ${idx + 1}] ${m}`) : undefined,
    ),
  )
  return Promise.all(tasks)
}

export async function finalAggregation(
  question: string,
  candidates: string[],
  systemPrompt: string,
  debugLog?: (msg: string) => Promise<void>,
): Promise<{ answer: string; reasoning: string }> {
  const deliberationContext = candidates
    .map((a, idx) => `${idx + 1}. ${a}`)
    .join('\n')
  const finalPrompt = `Original question:\n${question}\n\nCandidate answers (for internal use only):\n${deliberationContext}\n\nPlease provide the best possible answer to the original question. Respond with the answer only and do not mention or reference the candidate answers.`

  const stream = await streamText({
    model: xai('grok-3-mini'),
    prompt: finalPrompt,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: 'high' } },
  })

  let answer = ''
  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk)
    answer += chunk
  }
  const reasoning = ((await stream.reasoning) ?? '').trim()
  if (debugLog) await debugLog(`Final aggregation reasoning: ${reasoning}`)
  console.log()
  if (debugLog) await debugLog(`Ensemble answer: ${answer.trim()}`)
  return { answer: answer.trim(), reasoning }
}
