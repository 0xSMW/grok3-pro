#!/usr/bin/env ts-node

import React, { useState, useEffect } from 'react'
import { render, Text, Box, Static } from 'ink'
import { generateText, streamText } from 'ai'
import { xai } from '@ai-sdk/xai'
import * as fs from 'node:fs/promises'

// Types for results
type Result = { answer: string; rationale: string }

function App({
  question,
  k,
  filePath,
  systemPrompt,
}: {
  question: string
  k: number
  filePath?: string
  systemPrompt: string
}) {
  const [logs, setLogs] = useState<string[]>([])
  const [finalAnswer, setFinalAnswer] = useState<string>('')

  useEffect(() => {
    const log = (msg: string) => setLogs((prev) => [...prev, msg])

    async function run() {
      log(`Query: ${question}`)
      log(`Sampling ${k} variants ...`)

      const prompt = `Q: ${question}\nA:\nThink deeply about this and reason from first principles.`

      const tasks: Promise<Result>[] = Array.from({ length: k }).map(
        async (_, i) => {
          if (i === 0) {
            const result = await streamText({
              model: xai('grok-3-mini'),
              prompt,
              temperature: 1,
              system: systemPrompt || undefined,
              providerOptions: { xai: { reasoningEffort: 'high' } },
            })

            let answer = ''
            for await (const chunk of result.textStream) {
              answer += chunk
              setFinalAnswer((a) => a + chunk)
            }
            log('')
            const rationale = ((await result.reasoning) ?? '').trim()
            if (rationale) {
              log('--- Grok 3 Reasoning ---')
              log(rationale)
              log('---------------------------------')
            }
            return { answer: answer.trim(), rationale }
          }

          const { text, reasoning } = await generateText({
            model: xai('grok-3-mini'),
            prompt,
            temperature: 1,
            system: systemPrompt || undefined,
            providerOptions: { xai: { reasoningEffort: 'high' } },
          })
          return { answer: text.trim(), rationale: (reasoning ?? '').trim() }
        },
      )

      const results = await Promise.all(tasks)

      const counts = new Map<string, number>()
      for (const { answer } of results) {
        counts.set(answer, (counts.get(answer) ?? 0) + 1)
      }
      let best = ''
      let bestVotes = -1
      for (const [ans, votes] of counts.entries()) {
        if (votes > bestVotes) {
          best = ans
          bestVotes = votes
        }
      }
      log('')
      log(`Majority-vote answer: ${best}`)

      const topThree = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([ans]) => ans)
      if (topThree.length === 0) {
        topThree.push(best)
      }
      log(
        `Generating final answer based on top ${topThree.length} candidates ...`,
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

      setFinalAnswer('')
      for await (const chunk of finalStream.textStream) {
        setFinalAnswer((a) => a + chunk)
      }
      log('')
      const ensembleRationale = ((await finalStream.reasoning) ?? '').trim()
      if (ensembleRationale) {
        log('--- Grok 3 Final Reasoning ---')
        log(ensembleRationale)
        log('---------------------------------')
      }

      if (filePath) {
        let append = `\n\n--- Grok 3 Answer (${new Date().toLocaleString()}) ---\n${finalAnswer.trim()}\n`
        if (ensembleRationale) {
          append += `\n--- Grok 3 Reasoning ---\n${ensembleRationale}\n`
        }
        await fs.appendFile(filePath, append, 'utf8')
        log(`Appended final answer to '${filePath}'.`)
      }
    }

    run().catch((err) => log(String(err)))
  }, [question, k, filePath, systemPrompt])

  return (
    <Box flexDirection="column">
      <Static items={logs}>
        {(item, index) => <Text key={index}>{item}</Text>}
      </Static>
      {finalAnswer ? (
        <Box marginTop={1}>
          <Text color="green">{finalAnswer.trim()}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

async function resolveSystemPrompt(path: string): Promise<string> {
  try {
    const content = (await fs.readFile(path, 'utf8')).trim()
    if (content) {
      return content
    }
  } catch {
    // ignore
  }
  return ''
}

function parseArgs() {
  const [, , ...cli] = process.argv
  let questionArg: string | undefined
  let k = 9
  let filePath = ''
  let systemPath = ''

  for (let i = 0; i < cli.length; i++) {
    const arg = cli[i]
    if (arg === '--file' || arg === '-f') {
      filePath = cli[i + 1] ?? ''
      i++
    } else if (arg === '--system' || arg === '-s') {
      systemPath = cli[i + 1] ?? ''
      i++
    } else if (questionArg === undefined) {
      questionArg = arg
    } else if (!Number.isNaN(Number(arg))) {
      k = Number(arg)
    }
  }

  return { questionArg, k, filePath, systemPath }
}

;(async () => {
  const { questionArg, k, filePath, systemPath } = parseArgs()
  let question: string

  if (filePath) {
    question = (await fs.readFile(filePath, 'utf8')).trim()
  } else {
    question = questionArg ?? 'What is 101*3?'
  }

  const systemPrompt = systemPath
    ? await resolveSystemPrompt(systemPath)
    : await resolveSystemPrompt('system.txt')

  render(
    <App
      question={question}
      k={k}
      filePath={filePath || undefined}
      systemPrompt={systemPrompt}
    />,
  )
})()
