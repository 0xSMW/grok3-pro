#!/usr/bin/env ts-node

// Minimal subset of Node globals for this standalone script
declare const process: {
  argv: string[];
  exit: (code?: number) => void;
  stdout: { write: (chunk: string) => void };
};

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

import { generateText, streamText } from "ai";
import { xai } from "@ai-sdk/xai";
import { SingleBar, Presets } from "cli-progress";
import * as fs from "node:fs/promises";

type Result = { answer: string; rationale: string };

/** Main entry */
async function main() {
  const [, , ...cli] = process.argv;

  // --- Argument parsing ----------------------------------------------------
  let questionArg: string | undefined;
  let k = 9;
  let filePath = "";
  let systemPath = "";

  for (let i = 0; i < cli.length; i++) {
    const arg = cli[i];
    if (arg === "--file" || arg === "-f") {
      filePath = cli[i + 1];
      if (!filePath) {
        throw new Error("--file flag requires a path argument");
      }
      i++; // skip file path in next loop iteration
    } else if (arg === "--system" || arg === "-s") {
      systemPath = cli[i + 1];
      if (!systemPath) {
        throw new Error("--system flag requires a path argument");
      }
      i++;
    } else if (questionArg === undefined) {
      questionArg = arg;
    } else if (!Number.isNaN(Number(arg))) {
      k = Number(arg);
    }
  }

  let question: string;
  const usingFile = filePath !== "";

  if (usingFile) {
    // Read question from file
    question = (await fs.readFile(filePath, "utf8")).trim();
    if (!question) {
      throw new Error(`File '${filePath}' is empty – cannot derive question text`);
    }
  } else {
    question = questionArg ?? "What is 101*3?";
  }

  // Resolve system prompt ---------------------------------------------------
  let systemPrompt = "";
  try {
    // If the user specified a path, use it. Otherwise default to ./system.txt if it exists
    const candidate = systemPath || "system.txt";
    if (candidate) {
      systemPrompt = (await fs.readFile(candidate, "utf8")).trim();
      if (systemPrompt) {
        console.log(`Loaded system prompt from '${candidate}'.`);
      }
    }
  } catch {
    // ignore if file not found
  }

  console.log(`\nQuery: ${question}`);
  console.log(`Sampling ${k} variants …\n`);

  const prompt = `Q: ${question}\nA:\nThink deeply about this and reason from first principles.`;

  // Progress bar setup (k first-round samples + 1 final deliberation)
  const bar = new SingleBar({ clearOnComplete: true, hideCursor: true }, Presets.shades_classic);
  bar.start(k + 1, 0);

  // Launch k parallel requests
  const tasks: Promise<Result>[] = Array.from({ length: k }).map(async (_, i) => {
    if (i === 0) {
      // Stream the first sample so the user sees output immediately
      const result = await streamText({
        model: xai("grok-3-mini"),
        prompt,
        temperature: 1,
        system: systemPrompt || undefined,
        providerOptions: { xai: { reasoningEffort: "high" } }
      });

      let answer = "";
      for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        answer += chunk;
      }
      console.log(); // newline after streaming answer

      const rationale = ((await result.reasoning) ?? "").trim();

      if (rationale) {
        console.log("--- Grok 3 Reasoning ---");
        console.log(rationale);
        console.log("---------------------------------\n");
      }

      bar.increment();
      return { answer: answer.trim(), rationale };
    }

    // Non-streaming for the remaining samples (faster parallel execution)
    const { text, reasoning } = await generateText({
      model: xai("grok-3-mini"),
      prompt,
      temperature: 1,
      system: systemPrompt || undefined,
      providerOptions: { xai: { reasoningEffort: "high" } }
    });

    const res = {
      answer: text.trim(),
      rationale: (reasoning ?? "").trim(),
    };
    bar.increment();
    return res;
  });

  const results = await Promise.all(tasks);

  // Majority vote on plain answers
  const counts = new Map<string, number>();
  for (const { answer } of results) {
    counts.set(answer, (counts.get(answer) ?? 0) + 1);
  }
  let best = "";
  let bestVotes = -1;
  for (const [ans, votes] of counts) {
    if (votes > bestVotes) {
      best = ans;
      bestVotes = votes;
    }
  }

  console.log("\nMajority-vote answer:", best);

  // =============================================================
  // Derive the top three candidate answers and craft a new prompt
  // to obtain a single, higher-quality final answer.
  // =============================================================

  const topThree = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ans]) => ans);

  // Fallback: if we somehow have fewer than 3 unique answers, just use what we have.
  if (topThree.length === 0) {
    topThree.push(best);
  }

  console.log(`\nGenerating final answer based on top ${topThree.length} candidates …\n`);

  const deliberationContext = topThree
    .map((a, idx) => `${idx + 1}. ${a}`)
    .join("\n");

  const finalPrompt = `Original question:\n${question}\n\nCandidate answers (for internal use only):\n${deliberationContext}\n\nPlease provide the best possible answer to the original question. Respond with the answer only and do not mention or reference the candidate answers.`;

  const finalStream = await streamText({
    model: xai("grok-3-mini"),
    prompt: finalPrompt,
    temperature: 1,
    system: systemPrompt || undefined,
    providerOptions: { xai: { reasoningEffort: "high" } },
  });

  let ensembleAnswer = "";
  for await (const chunk of finalStream.textStream) {
    process.stdout.write(chunk);
    ensembleAnswer += chunk;
  }
  console.log(); // newline after streaming final answer

  const ensembleRationale = ((await finalStream.reasoning) ?? "").trim();

  if (ensembleRationale) {
    console.log("--- Grok 3 Final Reasoning ---");
    console.log(ensembleRationale);
    console.log("---------------------------------\n");
  }

  console.log("\nFinal answer:", ensembleAnswer.trim());

  // Append answer (and reasoning) back to the file if file-mode is enabled
  if (usingFile) {
    let append = `\n\n--- Grok 3 Answer (${new Date().toLocaleString()}) ---\n${ensembleAnswer.trim()}\n`;
    if (ensembleRationale) {
      append += `\n--- Grok 3 Reasoning ---\n${ensembleRationale}\n`;
    }
    await fs.appendFile(filePath, append, "utf8");
    console.log(`\nAppended final answer to '${filePath}'.`);
  }

  // Mark final deliberation step complete in progress bar
  bar.increment();
  bar.stop();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});