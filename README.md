# AI Benchmark Harness

A simple TypeScript CLI that evaluates language models against a set of benchmark prompts. Prompts live in `prompts.json`, and results are written to `results.json`.

---

## 🚀 Quick start

```bash
# 1 – install deps
pnpm install

# 2 – set your provider keys
export XAI_API_KEY="sk-your-xai-key"
export OPENAI_API_KEY="sk-your-openai-key"

# 3 – run the benchmark using Grok 3 Mini
pnpm start -- --model xai:grok-3-mini --best-of 3
```


Defaults are read from `config.yaml` if it exists. You can override them with CLI flags or by using the interactive menu (`--interactive`). The file lets you set the models, evaluator, and prompts path.

Run without flags to launch an interactive menu for selecting the model(s) to benchmark and the evaluator model. Use `--evaluator` to choose which model scores the answers and `--prompts` to load a custom prompts file.
Use `--best-of` to evaluate multiple samples per prompt and average the results.


---

## 📄 License

MIT © 2024 Your Name
