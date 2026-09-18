# Milo benchmark report

- Generated: 2026-09-18T04:25:28.571Z
- Gateway: `https://milo-gateway.fly.dev/v1`, posture `balanced`
- Fixed arms: fast = `deepseek/deepseek-v4-flash`, mid = `openai/gpt-5.6-luna`, frontier = `z-ai/glm-5.3`
- Baseline (estimated, never called): `anthropic/claude-fable-5.1` at $10/M in, $50/M out
- Judge: `anthropic/claude-sonnet-5`, total judge cost $2.771
- Providers: pinned per model, no fallbacks — deepseek/deepseek-v4-flash→alibaba, z-ai/glm-5.3-flash→baseten, xiaomi/mimo-v2.5→xiaomi, tencent/hy3→atlas-cloud, openai/gpt-5.6-luna→amazon-bedrock, deepseek/deepseek-v4.1-flash→together, minimax/minimax-m3→modelrun, z-ai/glm-5.3→baseten, google/gemini-3.8-flash→google-ai-studio, nvidia/nemotron-3-ultra-550b-a55b→baseten, anthropic/claude-sonnet-5→azure
- Examples: 120 (120 with a grader)

## Headline

Savings compare each arm's real cost with what the same prompt and completion tokens would cost on the baseline. `2x` assumes the baseline would have written twice the observed completion tokens. `oracle` is the fixed arm of each example's labeled tier: the ceiling for perfect routing.

| arm | ok/calls | graded | pass | quality vs frontier | cost | per call | baseline est. | savings | savings 2x | ttfb p50 | ttfb p95 | total p50 | out tok | reason tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `milo` | 99/120 | 99 | 81.8% | 137.3% | $0.299 | $0.00305 | $6.692 | 95.5% | 97.7% | 2397 ms | 7722 ms | 4819 ms | 1336 | 884 |
| `oracle` | 119/120 | 119 | 63.0% | 117.2% | $0.206 | $0.00173 | $3.752 | 94.5% | 97.2% | 1042 ms | 4552 ms | 3143 ms | 598 | 376 |
| `frontier` | 119/120 | 119 | 53.8% | 100.0% | $0.294 | $0.00247 | $3.313 | 91.1% | 95.4% | 1002 ms | 2256 ms | 3006 ms | 521 | 293 |
| `mid` | 120/120 | 120 | 85.8% | 160.9% | $0.165 | $0.00137 | $6.896 | 97.6% | 98.8% | 2703 ms | 7530 ms | 4724 ms | 1124 | 262 |
| `fast` | 119/120 | 119 | 68.9% | 128.1% | $0.044 | $0.00037 | $7.890 | 99.4% | 99.7% | 1001 ms | 1266 ms | 4779 ms | 1280 | 530 |
| `bestof-jev` | 118/120 | 118 | 77.1% | 142.2% | $0.201 | $0.00170 | $33.458 | 99.4% | 99.7% | 9719 ms | 54779 ms | 9719 ms | 5441 | 2641 |
| `bestof-oracle` | 118/120 | 118 | 82.2% | 151.6% | $0.190 | $0.00161 | $33.458 | 99.4% | 99.7% | 9213 ms | 53648 ms | 9213 ms | 5441 | 2641 |

## Routing (the `milo` arm)

- Tiers chosen: fast 33, mid 43, frontier 23
- Tier agreement with the label: 78.8% (n=99)
- Sticky (inherited) decisions: 0
- Jev latency: mean 336 ms, p95 581 ms (n=99)
- Routing overhead (routed TTFB minus the same model called directly): p50 647 ms, p95 2650 ms (n=76)
- Bad downgrades (routed cheaper than frontier, failed, frontier passed): 5 of 99
- Missed savings (routed to frontier, fast passed): 11 of 99

## Best-of-5 sampling on `deepseek/deepseek-v4-flash` (fast tier, prompt framings varied)

- Samples: 600 drawn over 120 examples; 576 succeeded, 576 graded, 576 ranked by Jev (0 ranking failures)
- Random pick (mean per-sample pass rate): 68.8%
- Coverage (some sample passes): 82.2% — the ceiling any selector could reach
- Jev as verifier: AUROC 0.868 on its quality score, 0.862 on its correctness probability (0.5 is chance)
- Where samples disagree (39 examples): Jev's pick passed 84.6% of the time, a random pick 57.2%, the oracle 100%
- Jev ranking latency: mean 460 ms per sample, charged at $0.00002 per call

| task type | n | single sample | random pick | jev pick | oracle |
| --- | --- | --- | --- | --- | --- |
| chat | 12 | 83.3% | 78.3% | 75.0% | 83.3% |
| edit | 12 | 66.7% | 78.3% | 91.7% | 91.7% |
| feature | 14 | 50.0% | 50.0% | 64.3% | 71.4% |
| debug | 12 | 66.7% | 58.3% | 58.3% | 75.0% |
| research | 13 | 69.2% | 54.2% | 76.9% | 84.6% |
| review | 12 | 66.7% | 58.3% | 75.0% | 75.0% |
| docs | 12 | 83.3% | 85.0% | 100.0% | 100.0% |
| ops | 13 | 46.2% | 57.4% | 61.5% | 61.5% |
| classify | 18 | 88.9% | 87.8% | 88.9% | 94.4% |

## Failed calls

- **r-040** `milo` (milo/auto): timeout
- **r-048** `milo` (milo/auto): timeout
- **r-054** `milo` (milo/auto): timeout
- **r-065** `milo` (milo/auto): timeout
- **r-067** `milo` (milo/auto): timeout
- **r-067** `bestof-jev` (deepseek/deepseek-v4-flash): no successful sample
- **r-067** `bestof-oracle` (deepseek/deepseek-v4-flash): no successful sample
- **r-074** `milo` (milo/auto): timeout
- **r-077** `milo` (milo/auto): timeout
- **r-079** `milo` (milo/auto): timeout
- **r-081** `milo` (milo/auto): timeout
- **r-092** `frontier` (z-ai/glm-5.3): timeout
- **r-092** `milo` (milo/auto): timeout
- **r-092** `fast` (deepseek/deepseek-v4-flash): timeout
- **r-092** `bestof-jev` (deepseek/deepseek-v4-flash): no successful sample
- **r-092** `bestof-oracle` (deepseek/deepseek-v4-flash): no successful sample
- **r-101** `milo` (milo/auto): timeout
- **r-102** `milo` (milo/auto): timeout
- **r-103** `milo` (milo/auto): timeout
- **r-105** `milo` (milo/auto): timeout
- **r-106** `milo` (milo/auto): timeout
- **r-114** `milo` (milo/auto): timeout
- **r-115** `milo` (milo/auto): timeout
- **r-117** `milo` (milo/auto): timeout
- **r-118** `milo` (milo/auto): timeout
- **r-119** `milo` (milo/auto): timeout
- **r-120** `milo` (milo/auto): timeout

## Per example

| id | type | band | label | milo tier | milo model | provider | milo | frontier | mid | fast | milo cost | baseline est. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r-001 | chat | 0 | fast | fast | deepseek/deepseek-v4-flash | DigitalOcean | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00115 |
| r-002 | chat | 0 | fast | fast | deepseek/deepseek-v4-flash | DigitalOcean | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00249 |
| r-003 | chat | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00452 |
| r-004 | chat | 0 | fast | fast | deepseek/deepseek-v4-flash | Venice | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00508 |
| r-005 | chat | 0 | fast | fast | deepseek/deepseek-v4-flash | Venice | ✓ | ✗ | ✓ | ✗ | $0.00023 | $0.058 |
| r-006 | chat | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00016 | $0.00685 |
| r-007 | chat | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✓ | ✗ | ✓ | $0.00012 | $0.00514 |
| r-008 | chat | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00017 | $0.00721 |
| r-009 | chat | 1 | fast | fast | deepseek/deepseek-v4-flash | DigitalOcean | ✓ | ✓ | ✓ | ✓ | $0.00011 | $0.028 |
| r-010 | chat | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00219 | $0.092 |
| r-011 | chat | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✗ | ✓ | $0.00077 | $0.032 |
| r-012 | chat | 3 | frontier | fast | deepseek/deepseek-v4-flash | NextBit | ✗ | ✓ | ✓ | ✓ | $0.00036 | $0.049 |
| r-013 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | Phala | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00199 |
| r-014 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | Alibaba | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00418 |
| r-015 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00277 |
| r-016 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | Phala | ✓ | ✓ | ✓ | ✓ | $0.00008 | $0.00907 |
| r-017 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00294 |
| r-018 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | GMICloud | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00261 |
| r-019 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00235 |
| r-020 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | GMICloud | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00518 |
| r-021 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00413 |
| r-022 | classify | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00002 | $0.00607 |
| r-023 | classify | 1 | fast | fast | deepseek/deepseek-v4-flash | Parasail | ✓ | ✓ | ✓ | ✓ | $0.00003 | $0.00446 |
| r-024 | classify | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✓ | ✓ | ✓ | $0.00014 | $0.00578 |
| r-025 | classify | 1 | fast | fast | deepseek/deepseek-v4-flash | AtlasCloud | ✓ | ✓ | ✓ | ✓ | $0.00006 | $0.011 |
| r-026 | classify | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00020 | $0.00854 |
| r-027 | classify | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✗ | $0.00045 | $0.019 |
| r-028 | classify | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✓ | $0.00043 | $0.018 |
| r-029 | classify | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✓ | ✗ | ✗ | $0.00026 | $0.011 |
| r-030 | classify | 3 | frontier | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✗ | ✓ | $0.00039 | $0.017 |
| r-031 | docs | 0 | fast | fast | deepseek/deepseek-v4-flash | AtlasCloud | ✓ | ✗ | ✓ | ✓ | $0.00002 | $0.00331 |
| r-032 | docs | 0 | fast | fast | deepseek/deepseek-v4-flash | Parasail | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.00666 |
| r-033 | docs | 0 | fast | fast | deepseek/deepseek-v4-flash | DigitalOcean | ✓ | ✗ | ✗ | ✓ | $0.00001 | $0.00112 |
| r-034 | docs | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✗ | ✓ | ✗ | $0.00019 | $0.00821 |
| r-035 | docs | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00019 | $0.00811 |
| r-036 | docs | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00013 | $0.00547 |
| r-037 | docs | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✓ | $0.00045 | $0.019 |
| r-038 | docs | 1 | fast | fast | deepseek/deepseek-v4-flash | GMICloud | ✓ | ✓ | ✓ | ✓ | $0.00007 | $0.018 |
| r-039 | docs | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✓ | $0.00186 | $0.078 |
| r-040 | docs | 2 | frontier | mid | milo/auto | – | err | ✓ | ✓ | ✓ | n/a | n/a |
| r-041 | docs | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✓ | $0.016 | $0.321 |
| r-042 | docs | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✗ | $0.014 | $0.285 |
| r-043 | review | 0 | fast | fast | deepseek/deepseek-v4-flash | NextBit | ✓ | ✓ | ✓ | ✓ | $0.00009 | $0.013 |
| r-044 | review | 0 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✓ | $0.00013 | $0.00561 |
| r-045 | review | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00047 | $0.020 |
| r-046 | review | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00043 | $0.018 |
| r-047 | review | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00028 | $0.012 |
| r-048 | review | 1 | mid | mid | milo/auto | – | err | ✓ | ✓ | ✓ | n/a | n/a |
| r-049 | review | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✗ | ✓ | $0.013 | $0.266 |
| r-050 | review | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✗ | ✗ | $0.00923 | $0.182 |
| r-051 | review | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00049 | $0.021 |
| r-052 | review | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.020 | $0.395 |
| r-053 | review | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.018 | $0.350 |
| r-054 | review | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-055 | edit | 0 | fast | fast | deepseek/deepseek-v4-flash | Alibaba | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.00608 |
| r-056 | edit | 0 | fast | fast | deepseek/deepseek-v4-flash | Novita | ✓ | ✓ | ✓ | ✓ | $0.00003 | $0.00492 |
| r-057 | edit | 1 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.00904 |
| r-058 | edit | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00010 | $0.00408 |
| r-059 | edit | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00034 | $0.014 |
| r-060 | edit | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00033 | $0.014 |
| r-061 | edit | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00029 | $0.012 |
| r-062 | edit | 2 | frontier | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✗ | ✗ | ✗ | $0.00089 | $0.037 |
| r-063 | edit | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00039 | $0.016 |
| r-064 | edit | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00025 | $0.011 |
| r-065 | edit | 2 | frontier | mid | milo/auto | – | err | ✗ | ✗ | ✗ | n/a | n/a |
| r-066 | edit | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✗ | $0.00526 | $0.103 |
| r-067 | edit | 3 | frontier | mid | milo/auto | – | err | ✗ | ✗ | ✗ | n/a | n/a |
| r-068 | feature | 0 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00069 | $0.029 |
| r-069 | feature | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00015 | $0.00651 |
| r-070 | feature | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00024 | $0.00992 |
| r-071 | feature | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✗ | $0.00047 | $0.020 |
| r-072 | feature | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✗ | ✓ | ✓ | $0.00096 | $0.040 |
| r-073 | feature | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00110 | $0.046 |
| r-074 | feature | 2 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-075 | feature | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.00802 | $0.159 |
| r-076 | feature | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✗ | $0.010 | $0.206 |
| r-077 | feature | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-078 | feature | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✓ | n/a | n/a |
| r-079 | feature | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✓ | n/a | n/a |
| r-080 | feature | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✗ | ✗ | $0.00264 | $0.052 |
| r-081 | feature | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-082 | debug | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.00974 |
| r-083 | debug | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00037 | $0.015 |
| r-084 | debug | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00031 | $0.013 |
| r-085 | debug | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00043 | $0.018 |
| r-086 | debug | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✗ | ✗ | $0.00070 | $0.012 |
| r-087 | debug | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.013 | $0.255 |
| r-088 | debug | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.00997 | $0.197 |
| r-089 | debug | 2 | mid | frontier | tencent/hy4-preview | Tencent | ✓ | ✓ | ✓ | ✗ | $0.018 | $0.350 |
| r-090 | debug | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✓ | $0.00062 | $0.026 |
| r-091 | debug | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✗ | $0.021 | $0.409 |
| r-092 | debug | 3 | frontier | mid | milo/auto | – | err | err | ✗ | err | n/a | n/a |
| r-093 | debug | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✗ | $0.020 | $0.388 |
| r-094 | debug | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✗ | ✓ | $0.021 | $0.415 |
| r-095 | research | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00001 | $0.00302 |
| r-096 | research | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00024 | $0.00994 |
| r-097 | research | 1 | fast | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00115 | $0.048 |
| r-098 | research | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✓ | ✓ | ✓ | $0.00023 | $0.00977 |
| r-099 | research | 2 | mid | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✓ | $0.020 | $0.405 |
| r-100 | research | 2 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✗ | $0.00484 | $0.095 |
| r-101 | research | 2 | frontier | mid | milo/auto | – | err | ✓ | ✓ | ✓ | n/a | n/a |
| r-102 | research | 2 | mid | mid | milo/auto | – | err | ✓ | ✓ | ✓ | n/a | n/a |
| r-103 | research | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-104 | research | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✓ | $0.017 | $0.333 |
| r-105 | research | 3 | frontier | mid | milo/auto | – | err | ✓ | ✓ | ✓ | n/a | n/a |
| r-106 | research | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-107 | research | 3 | frontier | frontier | tencent/hy4-preview | Tencent | ✓ | ✗ | ✓ | ✗ | $0.014 | $0.271 |
| r-108 | ops | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.012 |
| r-109 | ops | 0 | fast | fast | deepseek/deepseek-v4-flash | StreamLake | ✗ | ✓ | ✗ | ✗ | $0.00003 | $0.00560 |
| r-110 | ops | 1 | fast | fast | deepseek/deepseek-v4-flash | Baidu | ✓ | ✓ | ✓ | ✓ | $0.00005 | $0.00761 |
| r-111 | ops | 1 | fast | fast | deepseek/deepseek-v4-flash | Alibaba | ✓ | ✓ | ✓ | ✓ | $0.00004 | $0.00716 |
| r-112 | ops | 1 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✓ | ✗ | ✓ | ✗ | $0.00039 | $0.016 |
| r-113 | ops | 2 | mid | mid | openai/gpt-5.6-luna | OpenAI | ✗ | ✗ | ✗ | ✗ | $0.00184 | $0.077 |
| r-114 | ops | 2 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-115 | ops | 2 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✗ | n/a | n/a |
| r-116 | ops | 2 | mid | frontier | tencent/hy4-preview | Tencent | ✗ | ✗ | ✓ | ✗ | $0.00107 | $0.020 |
| r-117 | ops | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✓ | n/a | n/a |
| r-118 | ops | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✓ | n/a | n/a |
| r-119 | ops | 3 | frontier | mid | milo/auto | – | err | ✗ | ✗ | ✗ | n/a | n/a |
| r-120 | ops | 3 | frontier | mid | milo/auto | – | err | ✗ | ✓ | ✓ | n/a | n/a |
