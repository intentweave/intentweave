# Contributing to IntentWeave

First of all: **thank you for considering contributing to IntentWeave** ❤️

IntentWeave is an **OSS‑first project** with the goal of turning _human intent_ (text, specs, conversations, code, signals) into a **coherent, inspectable graph**. Contributions of all kinds are welcome: ideas, discussions, bug reports, docs, code, tests, profiles, and experiments.

---

## 🧭 Project Philosophy

Before contributing, it helps to understand the guiding principles:

1. **OSS‑first, vendor‑neutral**
   IntentWeave must remain usable without proprietary SaaS dependencies.

2. **Evidence over hallucination**
   Graph edges should be explainable, traceable, and debuggable.

3. **Separation of stages**
   Ingestion → Extraction → Materialization → Projection are explicit phases.

4. **Profiles over forks**
   Domain‑specific behavior should live in _profiles_, not hard‑coded logic.

5. **CLI is a first‑class interface**
   Everything should be automatable and CI‑friendly.

---

## 🤝 How You Can Contribute

### 1. Discussions & Ideas

- Architecture feedback
- Naming & semantics
- Graph modeling discussions
- LLM robustness and failure modes

➡️ Use **GitHub Discussions** (preferred) or open an issue if actionable.

---

### 2. Bug Reports

Please include:

- IntentWeave version / commit
- CLI command used
- Expected vs actual behavior
- Minimal reproducible input (if possible)

➡️ Open a **GitHub Issue** with label `bug`.

---

### 3. Documentation

Docs are as important as code:

- README improvements
- Architecture explanations
- Stage specs (MX, PX, CX, …)
- Examples & tutorials

➡️ PRs welcome, even for small fixes.

---

### 4. Code Contributions

Typical contribution areas:

- CLI commands
- Graph schema & semantics
- Extraction heuristics
- LLM adapters (local models preferred)
- Profile system
- Validation & diffing
- Visualization / export layers

---

## 🧩 Contribution Scope Guidelines

### ✔️ Good candidates

- Generic mechanisms
- Clear semantics
- Testable behavior
- Profile‑driven extensions

### ❌ Avoid

- Hard‑coding domain assumptions
- SaaS‑only dependencies
- "Magic" behavior without traceability
- One‑off hacks without tests

---

## 🛠️ Development Setup

```bash
# clone
 git clone https://github.com/<org>/intentweave.git
 cd intentweave

# install
 npm install

# build
 npm run build

# run CLI locally
 npx intentweave --help
```

(Exact commands may evolve — keep CONTRIBUTING.md updated when they do.)

---

## 🧪 Tests

- New features **should include tests** where reasonable
- Bug fixes **must include regression tests** if feasible
- Snapshot tests are allowed for graph outputs

```bash
npm test
```

---

## 🧠 LLM‑Related Contributions

Special care is required:

- Prompts must be deterministic and documented
- Prefer _small, local, specialized_ models
- Always provide a non‑LLM fallback or failure mode
- Extraction results must carry provenance metadata

If unsure: open a discussion **before** implementing.

---

## 🧱 Profiles

Profiles are the preferred extension mechanism.

Examples:

- `software-architecture`
- `sysml`
- `requirements-engineering`

A profile typically defines:

- Entity types
- Relation semantics
- Validation rules
- Optional extraction hints

➡️ New profiles should live in `profiles/`.

---

## 🔀 Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Keep commits focused and readable
4. Add/update tests and docs
5. Open a PR with a clear description

PRs may be squashed before merge.

---

## 📐 Style & Conventions

- TypeScript preferred
- Explicit types over `any`
- Clear naming > clever naming
- Favor readability over micro‑optimizations

---

## 📜 License

By contributing, you agree that your contributions will be licensed under the project’s open‑source license (see `LICENSE`).

**All contributions are subject to the Contributor License Agreement (CLA). (see `CLA.md`)**

---

## ❤️ Code of Conduct

Be respectful, constructive, and curious.

IntentWeave aims to be a place for **deep technical thinking without ego**.

---

If in doubt: **open a discussion first**. We’re happy to think together.

Welcome to IntentWeave ✨
