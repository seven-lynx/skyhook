# LLM Tagging

Optional classification stage: run each discovered item through a local or remote
model to assign a **category / subcategory** and **controlled tags**.

## Providers & model detection

Configure a list of providers; Skyhook probes each and shows one dropdown of
every available model.

| Provider | How it's detected |
|---|---|
| Ollama | `GET http://localhost:11434/api/tags` |
| LM Studio | `GET http://localhost:1234/v1/models` |
| llama.cpp / vLLM | OpenAI-compatible `/v1/models` on a configurable base URL |
| OpenAI / Anthropic / Groq / OpenRouter / Mistral | OpenAI-compatible, only if the API key is set |

## Config

```yaml
tagging:
  enabled: true
  providers:
    - { id: ollama,   baseUrl: "http://localhost:11434" }
    - { id: lmstudio, baseUrl: "http://localhost:1234/v1" }
    - { id: openai,   baseUrl: "https://api.openai.com/v1", apiKey: "sk-..." }
  model: "llama3.1:8b"                 # chosen after detectModels()
  promptFile: "config/tagging-prompt.txt"
  vocabFile:  "config/tags.json"
```

## Prompt

`config/tagging-prompt.txt` ships with a working template. Placeholders are
substituted before each call: `{title}`, `{description}`, `{url}`, `{categories}`,
`{tags}`. The model is asked to return JSON:

```json
{"category": "...", "subcategory": "...", "tags": ["..."]}
```

## Vocabulary

`config/tags.json` is the controlled tag list (optionally map tags → categories).
Seeded from `categories.json` by default.

## Editing (GUI)

Open `skyhook serve` → **Pipeline → Tagging**: **Detect models** → pick one → edit
the **prompt** (textarea) → edit the **tag list** → **test on a sample** → save.

## Programmatic

```js
import { detectModels, tag, loadText } from "skyhook";

const models = await detectModels(cfg.tagging.providers);
const tagged = await tag(rows, {
  provider: models[0],
  model: cfg.tagging.model,
  prompt: loadText(cfg.tagging.promptFile),
  vocab: JSON.parse(loadText(cfg.tagging.vocabFile)),
});
```

Tags are attached to each row as a `tags` array; persist them by mapping a
`"tags"` column in `schema.json`.
