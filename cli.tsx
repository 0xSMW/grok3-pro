#!/usr/bin/env node

import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import SelectInput from 'ink-select-input'

interface SettingsMenuProps {
  defaultModels: string[]
  defaultEvaluator: string
  defaultBestOf: number
  onSubmit: (models: string[], evaluator: string, bestOf: number) => void
}

const SettingsMenu = ({
  defaultModels,
  defaultEvaluator,
  defaultBestOf,
  onSubmit,
}: SettingsMenuProps) => {
  const [step, setStep] = useState<
    'models' | 'evaluator' | 'bestOfSelect' | 'bestOfCustom'
  >('models')
  const [models, setModels] = useState(defaultModels.join(','))
  const [evaluator, setEvaluator] = useState(defaultEvaluator)
  const [bestOf, setBestOf] = useState(String(defaultBestOf))

  if (step === 'models') {
    return (
      <Box flexDirection="column">
        <Text>Models to evaluate (comma separated):</Text>
        <TextInput
          value={models}
          onChange={setModels}
          onSubmit={() => setStep('evaluator')}
        />
      </Box>
    )
  }
  if (step === 'evaluator') {
    return (
      <Box flexDirection="column">
        <Text>Evaluator model:</Text>
        <TextInput
          value={evaluator}
          onChange={setEvaluator}
          onSubmit={() => setStep('bestOfSelect')}
        />
      </Box>
    )
  }

  const modelList = models
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (step === 'bestOfSelect') {
    const items = [
      { label: '1', value: '1' },
      { label: '3', value: '3' },
      { label: '5', value: '5' },
      { label: 'Custom…', value: 'custom' },
    ]
    return (
      <Box flexDirection="column">
        <Text>Number of samples per prompt:</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === 'custom') {
              setStep('bestOfCustom')
            } else {
              onSubmit(modelList, evaluator, Number(item.value))
            }
          }}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>Custom best-of value:</Text>
      <TextInput
        value={bestOf}
        onChange={setBestOf}
        onSubmit={() =>
          onSubmit(modelList, evaluator, parseInt(bestOf, 10) || 1)
        }
      />
    </Box>
  )
}
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

interface ResultItem {
  id: string
  question: string
  answer: string
  scores: Record<string, number>
  explanation: string
}

interface Props {
  models: string[]
  evaluator: string
  promptsPath: string
  bestOf: number
}

const App = ({ models, evaluator, promptsPath, bestOf }: Props) => {
  const [status, setStatus] = useState('Starting…')
  const { exit } = useApp()

  useEffect(() => {
    ;(async () => {
      try {
        setStatus('Loading prompts…')
        const prompts: PromptItem[] = JSON.parse(
          await fs.readFile(promptsPath, 'utf8'),
        )
        const results: Record<string, ResultItem[]> = {}
        for (const spec of models) {
          const modelInstance = getModel(spec)
          const perModel: ResultItem[] = []
          for (const item of prompts) {
            const attempts: any[] = []
            for (let i = 0; i < bestOf; i++) {
              setStatus(`Asking ${spec} - ${item.id} (${i + 1}/${bestOf})…`)
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
              attempts.push({ answer: answer.trim(), ...evalRes })
            }
            const agg: Record<string, number> = {}
            for (const att of attempts) {
              for (const [k, v] of Object.entries(att.scores)) {
                agg[k] = (agg[k] ?? 0) + v
              }
            }
            for (const k in agg) {
              agg[k] = agg[k] / attempts.length
            }
            perModel.push({
              id: item.id,
              question: item.question,
              attempts,
              scores: agg,
            })
          }
          results[spec] = perModel
        }
        const summary: Record<string, Record<string, number>> = {}
        for (const [spec, list] of Object.entries(results)) {
          const agg: Record<string, number> = {}
          for (const r of list) {
            for (const [k, v] of Object.entries(r.scores)) {
              agg[k] = (agg[k] ?? 0) + v
            }
          }
          for (const k in agg) {
            agg[k] = agg[k] / list.length
          }
          summary[spec] = agg
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
  let targets: string[] = ['xai:grok-3-mini']
  let evaluator = ''
  let promptsPath = 'prompts.json'
  let interactive = false
  let bestOf = 1
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--model' || arg === '--models') {
      targets = args[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg === '--evaluator') {
      evaluator = args[++i]
    } else if (arg === '--prompts') {
      promptsPath = args[++i]
    } else if (arg === '--interactive') {
      interactive = true
    } else if (arg === '--best-of') {
      bestOf = parseInt(args[++i], 10) || 1
    }
  }
  if (!evaluator) evaluator = targets[0]
  return { targets, evaluator, promptsPath, interactive, bestOf }
}

const { targets, evaluator, promptsPath, interactive, bestOf } = parseArgs()

const Root = () => {
  const [settings, setSettings] = useState<null | {
    models: string[]
    evaluator: string
    bestOf: number
  }>(interactive ? null : { models: targets, evaluator, bestOf })

  if (!settings) {
    return (
      <SettingsMenu
        defaultModels={targets}
        defaultEvaluator={evaluator}
        defaultBestOf={bestOf}
        onSubmit={(models, evalModel, bOf) =>
          setSettings({ models, evaluator: evalModel, bestOf: bOf })
        }
      />
    )
  }

  return (
    <App
      models={settings.models}
      evaluator={settings.evaluator}
      promptsPath={promptsPath}
      bestOf={settings.bestOf}
    />
  )
}

render(<Root />)
