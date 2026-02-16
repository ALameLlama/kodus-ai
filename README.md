<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2025/04/kodusai.png">
</p>

<p align="center">
  <a href="https://kodus.io" target="_blank">Website</a>
  .
  <a href="https://discord.gg/6WbWrRbsH7" target="_blank">Community</a>
  ·
  <a href="https://docs.kodus.io" target="_blank">Docs</a>
  .
  <a href="https://app.kodus.io" target="_blank"><strong>Try Kodus Cloud »</strong></a>
</p>

<p align="center">
   <a href='http://makeapullrequest.com'><img alt='PRs Welcome' src='https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=shields'/></a>
   <a href="https://github.com/kodustech/kodus-ai" target="_blank"><img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars"></a>
   <a href="./license.md"><img src="https://img.shields.io/badge/license-AGPLv3-red" alt="License"></a>
</p>

<h3 align="center">Ship better code faster with personalized, context-aware code reviews.</h3>

<p align="center">
  <a href="https://www.youtube.com/watch?v=rQo9rmQ2-zM">
    <img src="https://img.youtube.com/vi/rQo9rmQ2-zM/0.jpg" alt="Kodus Demo">
  </a>
</p>

<br/>

## Why Kodus?

Kodus is an open-source AI agent that reviews your code like a real teammate — but one that never gets tired of doing pull requests.

She helps your team catch bugs, enforce best practices, and keep your codebase clean without slowing you down. Think of her as that senior dev who actually likes doing reviews (yeah, we made one).

Kody (our agent) plugs into your Git workflow, learns how your team writes code, and starts reviewing PRs automatically. You decide what matters — performance, security, readability, or all of the above.

### Key Features

- **Context-Aware Intelligence** — Kodus learns your codebase, architecture patterns, and team standards to deliver relevant, actionable feedback.

- **Custom Review Policies** — Create review guidelines in plain language, or any language of your choice, that align with your team's engineering principles and practices.

- **Native Git Integration** — Seamlessly integrates with your existing workflow, providing detailed feedback directly in pull requests.

- **Continuous Learning** — Improves over time by incorporating feedback and adapting to your team's preferences and standards.

## Supported Languages

Kodus supports **all programming languages** with two levels of analysis:

### 💡 **All Languages** - Semantic Analysis (LLM)
Every programming language receives full semantic review via LLM covering style, best practices, code smells, and intelligent feedback.

### 🚀 **Enhanced Support** - Additional AST Analysis
These languages get everything above **plus** structural analysis via AST parsing for:
- Lower noise and duplicate detection
- Similarity analysis between code blocks
- Node-level structural validation
- Enhanced accuracy in complex scenarios

| Language | Enhanced Features |
|----------|------------------|
| TypeScript | ✅ AST + Semantic |
| JavaScript | ✅ AST + Semantic |
| Python | ✅ AST + Semantic |
| Java | ✅ AST + Semantic |
| Go | ✅ AST + Semantic |
| Ruby | ✅ AST + Semantic |
| PHP | ✅ AST + Semantic |
| C# | ✅ AST + Semantic |
| Rust | ✅ AST + Semantic |

**All other languages work perfectly with semantic analysis!** Including Swift, Kotlin, Scala, Dart/Flutter, Elixir, Erlang, Haskell, Julia, R, MATLAB, Objective-C, Perl, Lua, Crystal, Clojure, Groovy, VB.NET, F#, Nim, Zig, OCaml, Solidity, Move, VHDL, Verilog, Assembly, Fortran, COBOL, Smalltalk, PowerShell, Tcl, Scheme, Common Lisp, Elm, ReasonML, SML, Prolog, AWK, Makefile, and many more.

**Configuration & Template Languages:** HCL, TOML, INI, Gradle DSL, custom build DSLs, Graph languages (DOT), Template languages (Handlebars, Liquid), Markup variants (AsciiDoc, reST), Query/Graph DSLs (Gremlin, Cypher).

## Getting Started

### Monorepo Structure

- Backend services: `apps/api`, `apps/webhooks`, `apps/worker`
- Web frontend (Next.js): `apps/web`
- Shared code: `libs`, `packages`

For local environment setup, see `README-SETUP.md`.

Kodus is available in two editions:

### ☁️ Cloud Edition

Get started in minutes with our fully-managed solution:

- [Create a free account](https://app.kodus.io/signup)
- [View pricing](https://kodus.io/pricing)

### 🛠️ Self-Hosted Edition

Deploy Kodus on your own infrastructure with full control:

- [Installation Guide using our CLI](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm)
- [Installation Guide using our Docker file](https://docs.kodus.io/how_to_deploy/en/deploy_kodus/generic_vm)

## Open Source vs. Cloud vs. Enterprise

| Feature                                    | Open Source    | Cloud Pro | Enterprise     |
| ------------------------------------------ | -------------- | --------- | -------------- |
| Self Hosted                                | ✅             | ❌        | **You choose** |
| Unlimited Users                            | ✅             | ✅        | ✅             |
| Bring Your Own Key                         | ✅             | ❌        | ✅             |
| Kody Learnings                             | ❌             | ✅        | ✅             |
| Productivity and Quality Metrics           | ❌             | ✅        | ✅             |
| Premium Support                            | ❌             | ❌        | ✅             |
| Custom Integrations                        | ❌             | ❌        | ✅             |
| Advance compliance and code audit support  | ❌             | ❌        | ✅             |
| Review mode                                | 💡 Light       | 🚀 Heavy  | 🚀 Heavy       |
| Kody Rules                                 | Up to 10 rules | Unlimited | Unlimited      |

[View full comparison →](https://kodus.io/pricing)

## Have Questions?

Our team is here to help. [Schedule a 30-minute call](https://cal.com/gabrielmalinosqui/30min) with our founder to discuss how Kodus can optimize your code review process.

## Contributing

We welcome contributions from the community!
