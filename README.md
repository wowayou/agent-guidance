# agent-guidance

我的跨项目 AI Coding Agent 工作规范与轻量 Hook 配置。

这个仓库是共享 Agent 指令的 **Single Source of Truth（单一事实来源）**：全局规则只在这里维护，其他环境尽量引用或同步，而不是复制后各自修改。

## 目标

- 保持全局 `AGENTS.md` 短、稳定、可执行。
- 让 Agent 能挑战方案，但控制实际修改范围。
- 把验证、文档同步和真实交付纳入完成标准。
- 通过轻量 Hook 减少“代码改了，文档忘记同步”的情况，而不是强迫每次都制造 Markdown 改动。
- 不把具体项目的技术栈、架构或业务规则塞进全局指导。

## Repository Layout

```text
.
├── AGENTS.md
├── README.md
├── .agent-hooks/
│   ├── doc-review.mjs
│   ├── doc-review.test.mjs
│   └── config/
│       ├── claude.settings.fragment.json
│       └── codex.hooks.fragment.json
└── templates/
    ├── project-AGENTS.md
    └── ADR.md
```

## 使用方式

### Codex

将 `AGENTS.md` 作为个人全局指导的来源。若使用默认配置目录，可同步到 `~/.codex/AGENTS.md`；更推荐用符号链接或你自己的同步脚本保持单一维护源。

### Claude Code

在个人 `CLAUDE.md` 中引用这份共享规则，或通过你现有的配置同步方式使用。不要维护两份内容相同但独立修改的规则文件。

### 文档复核 Hook

`.agent-hooks/doc-review.mjs` 是一个提醒器，不是文档质量证明，也不会自动改文档。它在任务开始记录仓库基线，在 Agent 准备结束时检查本轮是否产生了项目改动；如果存在改动但交付中没有说明文档状态，则提醒 Agent 做一次文档影响复核。

运行本地校验：

```bash
node --check .agent-hooks/doc-review.mjs
node --test .agent-hooks/doc-review.test.mjs
```

Hook 配置示例位于 `.agent-hooks/config/`。配置是片段，应合并到已有客户端配置，不要直接覆盖其他权限或 Hook 设置。

## 分层原则

- **Global `AGENTS.md`**：跨项目长期有效的工作原则。
- **Project `AGENTS.md`**：当前仓库的架构、命令、技术约束和特殊规则。
- **ADR / Notes**：重要决策、为什么这样设计、何时需要重新评估。
- **Task / PRD**：当前任务的目标、范围和验收条件。

不要因为某条规则“也许以后有用”就加入全局文件。只有跨项目反复出现、删除后容易导致明确错误的行为约束，才值得进入全局 `AGENTS.md`。

## 维护规则

对本仓库进行有意义的规则或 Hook 修改后：

1. 检查最终 diff，避免无关改动和敏感信息。
2. 运行与改动范围相匹配的验证。
3. 必要时同步 README、模板或配置示例。
4. 使用清晰的 commit message 记录完成的改动。
5. 在远程和目标分支已经明确且 push 已授权的情况下，及时推送，不让本地版本长期漂移。

禁止为了“同步”而 force-push、改写历史、覆盖他人工作或把未验证内容直接发布。

## License

暂未指定开源许可证。公开可见不等于自动授予复制、修改或再分发许可；如后续希望正式开源，再明确选择许可证。
