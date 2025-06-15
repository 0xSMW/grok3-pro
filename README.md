# Grok³ Pro

A tiny CLI that asks xAI's **Grok 3 Mini** several times in parallel, majority-votes the results, and prints the winner.

---

## 🚀 Quick start

```bash
# 1 – install deps
pnpm install

# 2 – your xAI key
export XAI_API_KEY="sk-your-key"

# 3 – ask a one-off question
ts-node grok3-ink.tsx "What is 101 * 3?"

_`proto/grok3-pro.ts` is deprecated; use `grok3-ink.tsx`._
```

### Using a prompt file

Put your question in a text file (this repo ships with an example `prompt.txt`):

```bash
# will stream the first sample and append the final answer to prompt.txt
ts-node grok3-ink.tsx --file prompt.txt
```

---

## 🛠 Flags

| Flag                  | Description                                                  | Default |
| --------------------- | ------------------------------------------------------------ | ------- |
| `[k]`                 | number of parallel samples                                   | `5`     |
| `--file, -f <path>`   | read question from file and append the answer                | —       |
| `--system, -s <path>` | custom system prompt (falls back to `system.txt` if present) | —       |
| `--debug, -d`         | log intermediate steps to a timestamped file                 | `false` |

---

## 🧐 What happens internally

1. Compose a prompt: `Q: … A:` and launch _k_ requests with `temperature 0.9` and `reasoningEffort "high"`.
2. The first request streams so you see tokens immediately; the rest run non-streaming.
3. Tally identical `answer` strings and pick the majority.
4. Print the winning answer (plus Grok's hidden reasoning for the streamed call).

---

## 📦 Build once & run without ts-node

```bash
npx tsc grok3-ink.tsx --outDir dist
node dist/grok3-ink.js "Your question"
```

---

## 📄 License

MIT © 2024 Your Name
