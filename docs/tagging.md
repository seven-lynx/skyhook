# LLM Tagging

Status: **reference** — providers, the prompt and vocabulary files, and the gap-filling tasks. The
defaults it quotes come from `src/config.js`.

Optional classification stage: run each discovered item through a local or remote
model to assign a **category / subcategory** and **controlled tags**.

## Platform selection

In the Settings page (GUI) or via `POST /api/settings { taggingPlatform }`, choose
your active LLM platform from the list of providers configured in
`skyhook.config.json`. Skyhook uses the active platform for model detection, model
loading, and tagging. The selection persists in `.skyhook/settings.json` across restarts.

## Providers & model detection

Configure a list of providers; Skyhook probes the active platform and shows every
available model. For LM Studio, the **native REST API** (`GET /api/v1/models`)
returns all **downloaded** models (not just the one loaded into memory), including
each model's loaded state and instance id.

| Provider | How it's detected |
|---|---|
| Ollama | `GET http://localhost:11434/api/tags` |
| LM Studio | Native REST: `GET http://localhost:1234/api/v1/models` (all downloaded models, with `loaded_instances`) |
| llama.cpp / vLLM | OpenAI-compatible `/v1/models` on a configurable base URL |
| OpenAI / Anthropic / Groq / OpenRouter / Mistral | OpenAI-compatible, only if the API key is set |

When model detection fails (e.g. the platform is not running), the error is
returned alongside the models list and surfaced in the GUI as a hint.

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

## Model load/unload (LM Studio)

When a user selects a specific model and clicks **Load model** (or runs a tagging
task), Skyhook automatically manages the model lifecycle:

1. Queries the list of downloaded models to check current state.
2. If the requested model is **already loaded** → no action.
3. If a **different** model is loaded → unloads it first (avoids double instances).
4. Loads the target model via `POST /api/v1/models/load`.

This happens server-side before any tagging worker is launched, and `skyhook tag`
does the same before its first batch: the configured `tagging.model` is resolved
against what the provider lists. An id carrying a quantisation suffix
(`llama-3.1-8b@q4_k_m`) resolves on its base id — that is what `/v1/models`
lists — while the pass still sends the configured string. A model that is
downloaded but not loaded is loaded first; one the provider does not have at all
is refused with the ids it does have, before any GPU time is spent. An
unreachable provider is not a refusal: the first completion reports it.

The API is `POST /api/tagging/models/load { model, provider? }` and returns
`{ alreadyLoaded, loaded, instanceId, loadTimeSeconds }`.

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

## One pass, three tables

The canonical `skyhook tag` pass asks for **tags, attributes and quality in a single
response**, and writes all three from it:

| Table | What the canonical pass writes |
|---|---|
| `local_url_tags` | the topic tags, canonicalised against the vocabulary |
| `local_url_attributes` | audience_level, content_type, depth, tone, is_news |
| `local_url_quality` | url_type, quality_score, the nine boolean flags |

A task pass is narrower by design, but `fill-tags` writes the attributes and quality the
model returned in the same response when it returned them - so a tags pass does not cost
a second GPU hour for columns already in hand. `fill-attributes` and `fill-quality` exist
for the corpus that was tagged before that was true.

Practical consequence: to move a corpus forward, run the canonical pass over the rows you
want redone. Reach for a task only when you want **one** column re-read on URLs that
already have the others.

## The value contract: `tagging.enums`

Every value the model may emit is declared once, in `tagging.enums`
(`src/config.js` `DEFAULTS`; narrow it in `skyhook.config.json`):

```jsonc
"enums": {
  "values":    { "audience_level": […], "content_type": […], "depth": […], "tone": […], "url_type": […] },
  "aliases":   { "tone": { "formal": "serious" } },   // applied only when the raw value is not accepted
  "fallbacks": { "tone": ["neutral"], "content_type": "other" },
  "arrays":    ["tone"],                              // stored as a JSON array, always
  "booleans":  ["is_news", "is_parked", …]            // sent as true/false, never 0/1
}
```

Three things read it, which is the point:

1. the worker, when it validates a response before writing it;
2. `skyhook upload`, which maps every value through `src/adapters/tagging/enums.js` and
   **drops + counts** anything unmapped instead of letting the database reject the batch;
3. the task prompts, which quote the same words (a test fails if they drift).

`tone` is always an array locally - `["neutral"]` - whether the model produced a string
or an array, and whether the writer was the canonical pass or a task.

## Editing (GUI)

Open `skyhook serve` → **Pipeline → Tagging**: choose a platform in
**Settings**, then use **Detect models** to list all downloaded models → pick one →
load it → edit the **prompt** → edit the **tag list** → run a task.

## Programmatic

```js
import { detectModels, tag, ensureModelLoaded, loadText } from "skyhook";

const { models, errors } = await detectModels(cfg.tagging.providers);
const loaded = await ensureModelLoaded(provider, chosenModel);

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
