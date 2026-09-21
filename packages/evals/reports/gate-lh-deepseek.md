# Milo benchmark report

- Generated: 2026-09-18T19:48:15.069Z
- Gateway: `https://milo-gateway.fly.dev/v1`, posture `balanced`
- Fixed arms: fast = `deepseek/deepseek-v4-flash`, mid = `openai/gpt-5.6-luna`, frontier = `z-ai/glm-5.3`
- Baseline (estimated, never called): `anthropic/claude-fable-5.1` at $10/M in, $50/M out
- Judge: `openai/gpt-5.6-luna`, judge cost $0.00615 (fresh calls only; cache 0 hits, 4 misses)
- Judge audit: `anthropic/claude-sonnet-5` re-judged 0 of 4 judged answers (fraction 10.0%): agreement n/a, pass-rate delta n/a (primary minus audit); primary judge $0.00615, audit $0.00000
- Spend: $0.084 upstream — arms $0.078, judge $0.00615
- Providers: pinned per model, no fallbacks — deepseek/deepseek-v4-flash→alibaba, z-ai/glm-5.3-flash→baseten, xiaomi/mimo-v2.5→xiaomi, tencent/hy3→atlas-cloud, openai/gpt-5.6-luna→amazon-bedrock, deepseek/deepseek-v4.1-flash→together, minimax/minimax-m3→modelrun, z-ai/glm-5.3→baseten, google/gemini-3.8-flash→google-ai-studio, nvidia/nemotron-3-ultra-550b-a55b→baseten, anthropic/claude-sonnet-5→azure
- Examples: 16 (16 with a grader)

## Headline

Savings compare each arm's real cost with what the same prompt and completion tokens would cost on the baseline. `2x` assumes the baseline would have written twice the observed completion tokens. `oracle` is the fixed arm of each example's labeled tier: the ceiling for perfect routing.

| arm | ok/calls | graded | pass | quality vs frontier | cost | per call | baseline est. | savings | savings 2x | ttfb p50 | ttfb p95 | total p50 | out tok | reason tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `milo` | 16/16 | 16 | 87.5% | n/a | $0.078 | $0.00489 | $7.741 | 99.0% | 99.5% | 43500 ms | 284119 ms | 43500 ms | 9374 | 7428 |

## Routing (the `milo` arm)

- Tiers chosen: fast 7, mid 0, frontier 9
- Tier agreement with the label: 50.0% (n=16)
- Server-side sampled decisions: 9 (tier counts use the policy's unsampled choice)
- Sticky (inherited) decisions: 0
- Jev latency: mean 487 ms, p95 1198 ms (n=16)
- Routing overhead (routed TTFB minus the same model called directly): p50 n/a, p95 n/a (n=0)
- Bad downgrades (routed cheaper than frontier, failed, frontier passed): 0 of 0
- Missed savings (routed to frontier, fast passed): 0 of 0

## Failed calls

None.

## Per example

| id | type | band | label | milo tier | milo model | provider | milo | frontier | mid | fast | milo cost | baseline est. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lh-001 | research | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | Alibaba | ✓ | – | – | – | $0.011 | $0.932 |
| lh-002 | debug | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | DeepInfra | ✓ | – | – | – | $0.00461 | $0.618 |
| lh-003 | review | 2 | frontier | frontier | deepseek/deepseek-v4.1-flash | Alibaba | ✗ | – | – | – | $0.00000 | $0.267 |
| lh-004 | research | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00031 | $0.115 |
| lh-005 | ops | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | – | ✓ | – | – | – | $0.020 | $1.703 |
| lh-006 | feature | 2 | mid | frontier | deepseek/deepseek-v4.1-flash | Alibaba | ✓ | – | – | – | $0.010 | $0.852 |
| lh-007 | docs | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00015 | $0.076 |
| lh-008 | research | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | Alibaba | ✓ | – | – | – | $0.012 | $0.981 |
| lh-009 | edit | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00016 | $0.068 |
| lh-010 | edit | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00043 | $0.207 |
| lh-011 | docs | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00025 | $0.112 |
| lh-012 | edit | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00028 | $0.134 |
| lh-013 | ops | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | – | ✓ | – | – | – | $0.00223 | $0.185 |
| lh-014 | feature | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | Alibaba | ✓ | – | – | – | $0.012 | $1.014 |
| lh-015 | research | 3 | frontier | frontier | deepseek/deepseek-v4.1-flash | – | ✗ | – | – | – | $0.00355 | $0.294 |
| lh-016 | ops | 2 | mid | fast | deepseek/deepseek-v4-flash | – | ✓ | – | – | – | $0.00037 | $0.183 |
