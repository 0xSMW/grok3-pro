#!/usr/bin/env node

import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { generateText } from 'ai'
import { xai } from '@ai-sdk/xai'
import { openai } from '@ai-sdk/openai'
import * as fs from 'node:fs/promises'

interface PromptItem {
  id: string
  type: 'factual' | 'hypothetical'
  question: string
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

interface Props {
  model: string
  evaluator: string
  promptsPath: string
}

const App = ({ model, evaluator, promptsPath }: Props) => {
  const [status, setStatus] = useState('Starting…')
  const { exit } = useApp()

  useEffect(() => {
    ;(async () => {
      try {
        setStatus('Loading prompts…')
        const prompts: PromptItem[] = JSON.parse(
          await fs.readFile(promptsPath, 'utf8'),
        )
        const modelInstance = getModel(model)
        const results = [] as any[]
        for (const item of prompts) {
          setStatus(`Asking ${item.id}…`)
          const { text: answer } = await generateText({
            model: modelInstance,
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
        setStatus('Wrote results.json')
        exit()
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`)
        exit()
      }
    })()
  }, [])

  return (
    <Box>
      <Text>
        <Spinner /> {status}
      </Text>
    </Box>
  )
}

function parseArgs() {
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
  return { target, evaluator, promptsPath }
}

const { target, evaluator, promptsPath } = parseArgs()

render(<App model={target} evaluator={evaluator} promptsPath={promptsPath} />)
