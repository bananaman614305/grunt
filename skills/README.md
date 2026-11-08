# Installing the Milo skill

This repository is itself a Claude Code plugin marketplace (see
`.claude-plugin/marketplace.json`) that ships one plugin, `milo`, whose only
component is `skills/milo/SKILL.md`.

## Claude Code

```sh
claude plugin marketplace add bananaman614305/milo
claude plugin install milo@milo
```

## Any other skill-aware agent

Tools that consume the [`skills` convention](https://github.com/anthropics/skills)
rather than Claude Code's own plugin system can install the same file with:

```sh
npx skills add bananaman614305/milo --skill milo
```
