# archon-provider-qwen

An [Archon](https://github.com/coleam00/Archon) provider plugin that runs Archon agent
sessions through the [Qwen Code](https://github.com/QwenLM/qwen-code) CLI (`qwen`). Point
Qwen Code at a local OpenAI-compatible server such as LM Studio and your Archon workflows
run on a local model.

Provider id: `qwen`. Requires Archon `>= 0.14.0` (provider plugin protocol 3).

## Install

1. Install and configure Qwen Code (tested with 0.24.6) so that `qwen "hello"` works in a
   terminal. The plugin uses Qwen Code's own settings and auth (`~/.qwen/settings.json`,
   `modelProviders`, env keys) and does not change them. An LM Studio example:

   ```json
   {
     "security": { "auth": { "selectedType": "openai" } },
     "modelProviders": {
       "openai": [
         { "id": "qwen/qwen3.8-27b", "name": "LM Studio", "baseUrl": "http://localhost:1234/v1", "envKey": "LMSTUDIO_API_KEY" }
       ]
     },
     "model": { "name": "qwen/qwen3.8-27b" },
     "env": { "LMSTUDIO_API_KEY": "lm-studio" }
   }
   ```

2. Install the plugin:

   ```sh
   archon plugin add Holtkamp-Consulting/archon-provider-qwen
   # or pin a release
   archon plugin add Holtkamp-Consulting/archon-provider-qwen@v0.1.0
   ```

   Restart a running `archon serve` afterwards. The plugin finds `qwen` on `PATH`; set
   `ARCHON_QWEN_PATH=/absolute/path/to/qwen` to use another binary.

## Configure

Workflow:

```yaml
provider: qwen
model: qwen/qwen3.8-27b   # optional
nodes:
  - id: implement
    prompt: Fix the failing test.
```

Or as the default in `.archon/config.yaml`:

```yaml
assistant: qwen
assistants:
  qwen:
    model: qwen/qwen3.8-27b   # optional
```

`model` is the only setting. Leave it out to use the model selected in Qwen Code's
settings. When it is set, the plugin passes `--model` and fails the turn as
`misconfigured` if Qwen Code starts with a different model (Qwen Code silently falls back
to its default for an unknown model id).

`examples/qwen-smoke.yaml` is a three-node smoke workflow (file edit, `output_format`
with `allowed_tools: []` and an explicit model, bash assertion). Copy it to a scratch
repository's `.archon/workflows/` and run `archon workflow run qwen-smoke "smoke"`.

## How it runs

Each turn starts one `qwen` process in its own process group, in the node's working
directory:

```
qwen --output-format stream-json --include-partial-messages --input-format text \
     --approval-mode yolo --chat-recording \
     (--session-id <new uuid> | --resume <id> [--fork-session]) [--model <m>] \
     [--system-prompt … | --append-system-prompt …] [--json-schema <schema>] \
     [--core-tools … --exclude-tools …]
```

The prompt is written to stdin. Tool calls are auto-approved (`yolo`): nobody can answer a
permission prompt in a headless run. `--chat-recording` is always on because resume and
failure classification read Qwen Code's session transcript.

Event mapping: assistant text becomes `agent_message_chunk` (coalesced per block),
thinking becomes `agent_thought_chunk`, `tool_use` becomes `tool_call` and its
`tool_result` the single `tool_call_update` (`failed` when Qwen Code marks it an error;
calls still open at the end of a turn or on cancellation close as `cancelled`). Qwen
Code's `result` becomes the `result` chunk with token usage, turn count, stop reason and
the model Qwen Code reported, followed by `settled` once the process has exited.
Partial-message traffic and sub-agent activity only produce throttled `heartbeat`s.

Cancellation sends SIGTERM to the process group, then SIGKILL after 3 s, and ends the
stream without a result or `settled`.

## Capabilities

| Capability | Declared | Why |
| --- | --- | --- |
| `sessionResume` | yes | `--resume <id>`; the result carries Qwen Code's session id. A resume of a session that has no transcript is reported with `sessionNotFound`. |
| `toolRestrictions` | yes | `allowed_tools` → `--core-tools` plus `--exclude-tools` for every other known tool (Qwen Code keeps `agent`, `skill`, `tool_call`, … enabled otherwise); `denied_tools` → `--exclude-tools`. The tool list Qwen Code reports at startup is checked; a mismatch fails the turn as `misconfigured` before the model is called. Use Qwen Code tool names (`read_file`, `edit`, `write_file`, `run_shell_command`, `grep_search`, `glob`, …), not Claude names. |
| `structuredOutput` | `best-effort` | `--json-schema` makes Qwen Code offer a `structured_output` tool and validate its arguments, but decoding is not grammar-constrained. If the model answers in text instead, the plugin parses a JSON object out of the reply. Archon validates and re-asks up to 3 times. |
| `envInjection` | yes | Archon's per-request environment reaches `qwen`. |
| token / stop reason / turn count / resolved model reporting | yes | From Qwen Code's `result` and `system/init` events. |
| `backgroundWork` | `unobserved` | Qwen Code can start background shells and sub-agents that stream-json does not report. |
| `costReporting`, `costControl` | no | Qwen Code reports no cost; local models have none. |
| `mcp`, `skills`, `plugins`, `hooks`, `agents`, `settingSources` | no | Qwen Code loads its own MCP servers, skills, hooks and sub-agents from its settings; the plugin does not select them per node. Nodes that name MCP servers, skills or plugins fail before any spend. |
| `effortControl`, `fallbackModel`, `sandbox`, `nativeTools`, `containerExec`, `sessionFork` | no | Not implemented. |

`checkCredential` returns `not_checked` (Qwen Code cannot check auth without a model
request), or `check_failed` when the `qwen` CLI is missing.

## Failures

Failures are classified from structured signals only:

- `qwen` missing or not executable, or a requested model Qwen Code does not select →
  `misconfigured`.
- HTTP status of the failed API call, read from the `qwen-code.api_error` record in Qwen
  Code's session transcript (`status_code`, `error_type`): 401/403 `auth`, 402
  `quota_exhausted`, 404 `misconfigured`, 429 `rate_limited`, 503/529 `overloaded`, other
  5xx/408 and connection errors `transient`.
- Qwen Code exit codes: 42/44/52 `misconfigured`, 55 (budget, wall time, tool-call cap)
  `budget_exceeded`, 53 turn limit (`stopReason: max_turn_requests`).
- Anything else is `unknown`; the vendor's message is kept as evidence.

## Limitations

- Host execution only (no container runs).
- Small local models are unreliable at structured output; expect Archon re-asks.
- Qwen Code's own extensions, skills, memory, MCP servers and sub-agents from
  `~/.qwen` stay active in every run.
- Background processes a tool starts with `&` outlive the turn, as with every provider.
- Cancellation reaches every process in the `qwen` process group; a descendant that
  starts its own session (`setsid`) escapes it.

## Development

```sh
bun install
bun test           # conformance in process and against a compiled executable, using
                   # test/fixtures/fake-qwen.ts (no LLM, no Qwen Code install needed)
bun run type-check
bash scripts/build.sh   # dist/archon-provider-qwen-<os>-<arch>
```

`vendor/provider-contract` is a copy of `@archon/provider-contract` from Archon v0.14.0
(see `vendor/provider-contract/VENDORED.md`); it is not published to npm.

Releases: bump `version` in `package.json`, then push a tag `v<version>` (or
`v<version>-rc.N` for a pre-release). The release workflow builds
`archon-provider-qwen-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`, runs the
conformance suite against the darwin-arm64 and linux-x64 executables, and publishes them
with `checksums.txt`.

## License

MIT. `vendor/provider-contract` is MIT-licensed by its authors (see its `LICENSE`).
