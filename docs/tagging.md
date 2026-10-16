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

## Fill-missing-info tasks (targeted LLM passes)

When a URL is missing its category, subcategory, tags, content type, quality, or
attributes, you can run a **targeted task** that sends only the gap-filling prompt
to the LLM. Each task is config-driven and ships with a draft prompt you can edit.

### Task list (offline DB)

| Task key | Fills | Selects URLs where | Prompt file |
|---|---|---|---|
| `fill-category` | `urls.category_id` | `category_id IS NULL` | `config/prompts/fill-category.md` |
| `fill-subcategory` | `urls.subcategory_id` | `subcategory_id IS NULL` (category set) | `config/prompts/fill-subcategory.md` |
| `fill-tags` | `local_url_tags` | no rows in `local_url_tags` | `tagging.promptFile` (canonical) |
| `fill-content-type` | `local_url_attributes.content_type` | no attributes row, or `content_type IS NULL` | `config/prompts/fill-content-type.md` |
| `fill-quality` | `local_url_quality` (all fields) | no quality row, or `quality_score IS NULL` | `config/prompts/fill-quality.md` |
| `fill-attributes` | `local_url_attributes` (audience/depth/tone/is_news) | no attributes row, or `audience_level IS NULL` | `config/prompts/fill-attributes.md` |
| `fill-tags-sparse` | `local_url_tags` | fewer than `minTags` tags (default 3) | `tagging.promptFile` (canonical) |

**Recheck** tasks (`reprocess: true` — reprocess already-filled URLs):

| Task key | Rechecks | Selects URLs where |
|---|---|---|
| `recheck-category` | category | all eligible URLs |
| `recheck-subcategory` | subcategory | category already set |
| `recheck-tags` | tags | all eligible URLs |
| `recheck-content-type` | content type | all eligible URLs |
| `recheck-quality` | quality | all eligible URLs |
| `recheck-attributes` | attributes | all eligible URLs |
| `recheck-low-confidence-attributes` | attributes | existing fill has `confidence < 0.7` |
| `recheck-low-confidence-quality` | quality | existing fill has `confidence < 0.7` |

### Config

Add an optional `tagging.tasks` array to override the shipping defaults:

```yaml
tagging:
  tasks:
    - { key: "fill-category",  label: "Fill missing categories",
        promptFile: "config/prompts/fill-category.md",
        filterClause: "AND u.category_id IS NULL", target: "category",
        resumeSource: "task:fill-category" }
    - { key: "recheck-category", label: "Recheck all categories",
        promptFile: "config/prompts/fill-category.md",
        filterClause: "", target: "category",
        resumeSource: "task:recheck-category", reprocess: true }
    - { key: "fill-tags-sparse", label: "Add tags to URLs with few tags",
        target: "tags", resumeSource: "task:fill-tags-sparse", minTags: 3 }
```

Task fields: `key`, `label`, `promptFile` (with a `## System Prompt` section),
`filterClause` (a SQL `WHERE` fragment against `urls u`), `target`
(category / subcategory / tags / contentType / quality / attributes), and
`resumeSource` (an independent resume marker).

- `reprocess: true` skips the "already tagged by this run" exclusion, so the
  task re-runs every eligible URL (used by the `recheck-*` tasks).
- `minTags: N` (tags target only) selects URLs with fewer than `N` tags — set it
  in config, or override it from the GUI's "Min tags" input.

### Running a task

- **GUI** — Pipeline tab → **"Targeted LLM tasks"**: pick a **Task**, optionally
  pick a **Model** (detected from your configured providers; blank uses
  `tagging.model`), set **Min tags** for the sparse-tags task, then **Run**.
  Progress streams in the live-log drawer under a `task:<key>` tab. The
  **Tagging Gaps** cards show how many URLs are missing each kind of info.
- **CLI** — `skyhook tag --task fill-category [--model NAME] [--provider NAME] [--min-tags N]`
- **API** — `GET /api/tagging/tasks` (task list), `GET /api/tagging/models`
  (installed models), `GET /api/tagging/missing` (counts), and
  `POST /api/tagging/run { task, model?, provider?, minTags? }`.
### Prompt convention

Task prompts use the same `## System Prompt` section convention as
`config/tagging-prompt.txt`. Return JSON in the task-specific shape (see each
shipped prompt). The `{categories}` placeholder is substituted for the
subcategory-fill prompt.
