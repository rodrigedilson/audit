# Claude Code Configuration - Audit Project

## Language & Communication

- ALL documentation, commit messages, PR descriptions, comments, and communication with the user MUST be in **Brazilian Portuguese (PT-BR)** with proper accents and UTF-8 encoding
- Agent rules, code, variable names, and technical identifiers remain in English (industry standard)
- When generating reports, summaries, or explanations, always use PT-BR

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

### Project Config

- **Topology**: hierarchical-mesh
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

## Build & Test

```bash
npm run build
npm test
npm run lint
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP
- ALWAYS batch ALL todos in ONE TodoWrite call
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message

## Software Engineering Agents

### Agent Team (`.claude/agents/software-engineering/`)

| Agent | Role | When to Use |
|-------|------|-------------|
| `tech-lead` | Coordination & decomposition | Complex features, multi-agent tasks |
| `architect` | System design & patterns | New modules, API design, refactoring |
| `coder` | Implementation | Feature coding, bug fixes |
| `debugger` | Bug investigation | Production issues, test failures |
| `tester` | Test creation & validation | After implementation, regression |
| `reviewer` | Code quality & review | Before merge, quality gates |
| `security-engineer` | Security assessment | Before deploy, sensitive changes |
| `performance-engineer` | Profiling & optimization | Slow endpoints, scaling issues |
| `docs-writer` | Documentation | API docs, architecture docs |
| `devops-engineer` | CI/CD & infrastructure | Pipeline setup, deployments |

### Agent Coordination Flow

```
User Request
    ↓
Tech Lead (decompose & assign)
    ↓
┌─────────────────────────────────────┐
│ Architect → Coder → Tester          │  (parallel where possible)
│ Security Engineer (async review)     │
│ Performance Engineer (async profile) │
└─────────────────────────────────────┘
    ↓
Reviewer (quality gate)
    ↓
DevOps (deploy)
```

## Hive Mind Configuration

### Topology: Hierarchical-Mesh
- **Queen**: Tech Lead (strategic coordination)
- **Workers**: Architect, Coder, Tester, Security, Performance, Docs, DevOps
- **Consensus**: Raft (leader maintains authoritative state)
- **Memory**: Shared namespace `software-engineering`

### Initialization
```bash
npx claude-flow hive-mind init -t hierarchical-mesh
npx claude-flow hive-mind spawn -n 8
```

### Hive Mind Rules
- Queen (tech-lead) decomposes and assigns all tasks
- Workers report progress via shared memory
- Consensus required for architectural decisions
- All agents share the `software-engineering` memory namespace
- Anti-drift: frequent checkpoints via post-task hooks

## GSD Integration

### Workflow
1. **GSD Phase Planning** → defines WHAT to build
2. **Hive Mind** → coordinates WHO builds it
3. **Agents** → execute HOW to build it

### Mapping
| GSD Concept | Hive Mind Equivalent | Agent Role |
|-------------|---------------------|------------|
| Phase | Hive Mission | Tech Lead assigns |
| Task | Worker Assignment | Specialist executes |
| Verification | Consensus | Reviewer validates |
| Roadmap | Queen Strategy | Architect designs |

### Integration Rules
- GSD phases map to hive-mind missions
- Each GSD task is assigned to a specialist agent
- GSD verification triggers reviewer + tester agents
- Progress is reported in both GSD and hive-mind formats
- Use `/gsd:execute-phase` to trigger hive-mind coordinated execution

## Swarm Configuration & Anti-Drift

- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use `raft` consensus for hive-mind
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents

## Swarm Execution Rules

- ALWAYS use `run_in_background: true` for all agent Task calls
- ALWAYS put ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT add more tool calls or check status
- Never poll TaskOutput or check swarm status — trust agents to return
- When agent results arrive, review ALL results before proceeding

## 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster (WASM) | <1ms | $0 | Simple transforms |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks (<30% complexity) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning (>30%) |

## Memory Commands Reference

```bash
npx claude-flow memory store --key "pattern-auth" --value "JWT with refresh" --namespace patterns
npx claude-flow memory search --query "authentication patterns"
npx claude-flow memory list --namespace patterns --limit 10
```

## V3 CLI Quick Reference

```bash
npx claude-flow agent spawn -t coder --name my-coder
npx claude-flow swarm init --v3-mode
npx claude-flow hive-mind init -t hierarchical-mesh
npx claude-flow hive-mind spawn --claude -o "Build a feature"
npx claude-flow doctor --fix
```
