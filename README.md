# claude_code_copy

一个自己的 coding agent。命令名是 `ccc`。

它只做一件事：把你的话交给模型，模型如果要读文件、改文件或跑命令，就调用工具，工具结果再送回模型，直到它给出回答。这是 Claude Code 那类产品的核心循环。这个目录里的代码是按这个循环重新写的，不包含、也不应该拷贝上一层解包出来的源码。

上一层仓库是 Anthropic 的研究材料。它依赖内部构建开关，公开包里还缺一批模块，不能当作你的程序直接编译发布。

## 跑起来

```bash
cd claude_code_copy
npm install
cp .env.example .env
```

`.env` 里二选一：

```bash
ANTHROPIC_API_KEY=你的key
ANTHROPIC_MODEL=claude-sonnet-4-5
```

```bash
OPENAI_API_KEY=你的key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
```

`OPENAI_BASE_URL` 指任何兼容 OpenAI Chat Completions 和 tools 的接口。

```bash
npm run dev                         # 对话
npm run dev -- -p "读一下 README，用三句话说明这个项目" 
npm run dev -- --permission-mode plan
npm test
```

单轮模式（`-p`）如果当前终端不能提问，改文件会被拒绝。要让它改文件，加上 `--permission-mode acceptEdits`。要让它跑命令，加上 `--dangerously-skip-permissions`。交互模式里，读文件直接执行，改文件和命令会先问你。

## 现在有什么

| 部分 | 作用 |
| --- | --- |
| `src/agent/loop.ts` | 模型 → 工具 → 再问模型 |
| `src/tools/builtin.ts` | `read_file` `write_file` `edit_file` `glob` `grep` `bash` |
| `src/permissions.ts` | `default` `acceptEdits` `plan` `bypass` |
| `src/llm/client.ts` | Anthropic，以及 OpenAI 兼容接口 |
| `.copy-agent/session.jsonl` | 这次运行的会话记录，已加入 gitignore |

工具路径必须落在启动时的工作目录里。指向目录外的符号链接也会被拒绝。`bash` 仍然是一个真的 shell，所以默认要你点头。

对话里可以用 `/help`、`/tools`、`/mode`、`/clear`、`/exit`。

## 接下来按这个顺序做

不要一次把终端 UI、子 agent、MCP 全写上。上一层能工作，是因为这些能力包在同一条循环外面。

1. 流式输出。现在是等整段回复回来才显示。
2. 会话恢复。把 `session.jsonl` 读回来，而不只是追加。
3. 权限规则。用 `Bash(npm test:*)` 这种允许列表，代替每次询问。
4. 上下文压缩。对话变长之后，让模型先写摘要再继续。
5. 子 agent。主循环把一个子任务交给另一个只有部分工具的循环。
6. MCP 和斜杠命令。外部工具和 `/commit` 这种固定动作。
7. 终端界面。循环稳定之后再做 Ink 那一层。

## 提交到 GitHub

远程仓库是 `https://github.com/zhangsscc99/claude_code_copy.git`。这个目录是独立的 git 仓库，不要把上一层的 `src/` 加进来。
