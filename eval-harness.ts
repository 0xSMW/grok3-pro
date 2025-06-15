#!/usr/bin/env ts-node

import { generateText } from 'ai'
import { xai } from '@ai-sdk/xai'
import { openai } from '@ai-sdk/openai'
import * as fs from 'node:fs/promises'

interface PromptItem {
  id: string
  type: 'factual' | 'hypothetical'
  question: string
}

interface ResultItem {
  id: string
  question: string
  answer: string
  scores: Record<string, number>
  explanation: string
}

function getModel(spec: string) {
  const [provider, model] = spec.includes(':')
    ? spec.split(':', 2)
    : ['xai', spec]
  if (provider === 'xai') return xai(model)
  if (provider === 'openai') return openai(model)
  throw new Error(`Unknown provider '${provider}'`)
}

async function evaluate(
  evalModel: string,
  question: string,
  answer: string,
  type: 'factual' | 'hypothetical',
) {
  const criteria =
    type === 'factual'
      ? 'Depth, Specificity, Reasoning, Presentation, Accuracy, Sourcing'
      : 'Depth, Specificity, Reasoning, Presentation, Plausibility, Grounding'

  const prompt = `You are an expert analyst evaluating an AI response.\n\nQuestion:\n${question}\n\nAnswer:\n${answer}\n\nAssess the answer on the following criteria: ${criteria}. Rate each from 0-5 and reply with a JSON object where keys are the criteria names and values are the scores. After the JSON, provide a short paragraph summarizing strengths and weaknesses.`

  const { text } = await generateText({
    model: getModel(evalModel),
    prompt,
    temperature: 0,
  })
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  let scores: Record<string, number> = {}
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      scores = JSON.parse(text.slice(firstBrace, lastBrace + 1))
    } catch {}
  }
  const explanation = lastBrace !== -1 ? text.slice(lastBrace + 1).trim() : text
  return { scores, explanation }
}

async function main() {
  const args = process.argv.slice(2)
  let target = 'xai:grok-3-mini'
  let evaluator = target
  let promptsPath = 'prompts.json'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--model') {
      target = args[++i]
    } else if (arg === '--evaluator') {
      evaluator = args[++i]
    } else if (arg === '--prompts') {
      promptsPath = args[++i]
    }
  }

  const prompts: PromptItem[] = JSON.parse(
    await fs.readFile(promptsPath, 'utf8'),
  )
  const model = getModel(target)

  const results: ResultItem[] = []
  for (const item of prompts) {
    const { text: answer } = await generateText({
      model,
      prompt: item.question,
      temperature: 0.7,
    })
    const evalRes = await evaluate(
      evaluator,
      item.question,
      answer.trim(),
      item.type,
    )
    results.push({
      id: item.id,
      question: item.question,
      answer: answer.trim(),
      ...evalRes,
    })
  }

  const summary: Record<string, number> = {}
  for (const r of results) {
    for (const [k, v] of Object.entries(r.scores)) {
      summary[k] = (summary[k] ?? 0) + v
    }
  }
  for (const k in summary) {
    summary[k] = summary[k] / results.length
  }

  await fs.writeFile(
    'results.json',
    JSON.stringify({ results, summary }, null, 2),
  )
  console.log('Wrote results.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
