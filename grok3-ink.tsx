#!/usr/bin/env ts-node

import React, { useState, useEffect } from 'react'
import { render, Text, Box, Static } from 'ink'
import TextInput from 'ink-text-input'
import { generateText, streamText } from 'ai'
import { xai } from '@ai-sdk/xai'
import * as fs from 'node:fs/promises'

// Types for results
type Result = { answer: string; rationale: string }

function SettingsMenu({
  defaults,
  onSubmit,
}: {
  defaults: {
    question: string
    k: number
    filePath: string
    systemPath: string
  }
  onSubmit: (opts: {
    question: string
    k: number
    filePath: string
    systemPath: string
  }) => void | Promise<void>
}) {
  const [step, setStep] = useState(0)
  const [question, setQuestion] = useState(defaults.question)
  const [k, setK] = useState(String(defaults.k))
  const [filePath, setFilePath] = useState(defaults.filePath)
  const [systemPath, setSystemPath] = useState(defaults.systemPath)

  if (step === 0) {
    return (
      <Box>
        <Text>Question: </Text>
        <TextInput
          value={question}
          onChange={setQuestion}
          onSubmit={() => setStep(1)}
        />
      </Box>
    )
  }
  if (step === 1) {
    return (
      <Box>
        <Text>Variants (k): </Text>
        <TextInput value={k} onChange={setK} onSubmit={() => setStep(2)} />
      </Box>
    )
  }
  if (step === 2) {
    return (
      <Box>
        <Text>File path (optional): </Text>
        <TextInput
          value={filePath}
          onChange={setFilePath}
          onSubmit={() => setStep(3)}
        />
      </Box>
    )
  }
  if (step === 3) {
    return (
      <Box>
        <Text>System prompt path: </Text>
        <TextInput
          value={systemPath}
          onChange={setSystemPath}
          onSubmit={() => {
            onSubmit({
              question,
              k: Number(k) || defaults.k,
              filePath: filePath.trim(),
              systemPath: systemPath.trim(),
            })
          }}
        />
      </Box>
    )
  }
  return null
}

function App({
  question,
  k,
  filePath,
  systemPrompt,
  debug,
}: {
  question: string
  k: number
  filePath?: string
  systemPrompt: string
  debug?: boolean
}) {
  const [logs, setLogs] = useState<string[]>([])
  const [finalAnswer, setFinalAnswer] = useState<string>('')

  useEffect(() => {
    let debugPath = ''
    const debugWrite = async (msg: string) => {
      if (!debug) return
      if (!debugPath) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        debugPath = `debug-${ts}.log`
        await fs.writeFile(debugPath, `Query: ${question}\n`, 'utf8')
        if (systemPrompt) {
          await fs.appendFile(
            debugPath,
            `System prompt: ${systemPrompt}\n`,
            'utf8',
          )
        }
        setLogs((prev) => [...prev, `Debug output -> ${debugPath}`])
      }
      await fs.appendFile(debugPath, msg + '\n', 'utf8')
    }
    const log = (msg: string) => {
      setLogs((prev) => [...prev, msg])
      debugWrite(msg).catch(() => {})
    }

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
      let final = ''
      for await (const chunk of finalStream.textStream) {
        final += chunk
        setFinalAnswer((a) => a + chunk)
      }
      await debugWrite(`Final answer: ${final}`)
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
  }, [question, k, filePath, systemPrompt, debug])

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
  let debug = false

  for (let i = 0; i < cli.length; i++) {
    const arg = cli[i]
    if (arg === '--file' || arg === '-f') {
      filePath = cli[i + 1] ?? ''
      i++
    } else if (arg === '--system' || arg === '-s') {
      systemPath = cli[i + 1] ?? ''
      i++
    } else if (arg === '--debug' || arg === '-d') {
      debug = true
    } else if (questionArg === undefined) {
      questionArg = arg
    } else if (!Number.isNaN(Number(arg))) {
      k = Number(arg)
    }
  }

  return { questionArg, k, filePath, systemPath, debug }
}

;(async () => {
  const { questionArg, k, filePath, systemPath, debug } = parseArgs()

  function Root() {
    const [opts, setOpts] = useState<{
      question: string
      k: number
      filePath: string
      systemPrompt: string
    } | null>(null)

    if (!opts) {
      return (
        <SettingsMenu
          defaults={{
            question: questionArg ?? 'What is 101*3?',
            k,
            filePath: filePath,
            systemPath: systemPath || 'system.txt',
          }}
          onSubmit={async (cfg) => {
            const systemPrompt = await resolveSystemPrompt(
              cfg.systemPath || 'system.txt',
            )
            setOpts({
              question: cfg.question,
              k: cfg.k,
              filePath: cfg.filePath,
              systemPrompt,
            })
          }}
        />
      )
    }

    return (
      <App
        question={opts.question}
        k={opts.k}
        filePath={opts.filePath || undefined}
        systemPrompt={opts.systemPrompt}
        debug={debug}
      />
    )
  }

  render(<Root />)
})()
