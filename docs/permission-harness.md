# 权限 harness 设计

状态：待审批。这份文档通过之前，不改权限代码。

这一轮把 `ccc` 的工具权限做成和 Claude Code 同一套判断方式。配置放在我们自己的 `.ccc`，不读取、不写入 `~/.claude` 或项目里的 `.claude`。

## 现在已经有的

`src/permissions.ts` 里的 `PermissionGate` 只有四种模式：`default`、`acceptEdits`、`plan`、`bypass`。读文件直接放行，改文件和命令会问。回答是允许、拒绝，或本会话记住整个工具名。没有规则文件。`bypass` 会跳过后面的所有检查。

## 这一轮做什么

1. 按下面的顺序决定允许、拒绝或提问。
2. 从用户、项目、项目本地三份设置里加载 `allow`、`deny`、`ask`。
3. 终端里每次提问给四个选择：允许一次、本会话允许、写入本地设置、拒绝。
4. 命令行可以用 `--allowed-tools` 和 `--disallowed-tools` 追加规则。

## 这一轮不做什么

- 不做法 `auto` 模式，也不另调一个模型给命令分类。
- 不做沙箱。
- 不做 PreToolUse 这类 hooks。
- 不做网页上的权限卡片。`src/server` 和 `src/web` 先保持未提交，不在这一轮接上。
- 不增加额外工作目录。
- 不接企业策略下发。

## 模式

对外名称和 Claude Code 一致。

| 模式 | 行为 |
| --- | --- |
| `default` | 读和搜索放行。改文件、命令，没有规则时提问。 |
| `acceptEdits` | 工作区内的 `Write` 和 `Edit` 放行。命令仍按规则和提问处理。 |
| `plan` | 只放行 `Read`、`Glob`、`Grep`。改文件和命令直接拒绝，不提问。 |
| `bypassPermissions` | 其余检查都过了之后放行。拒绝规则、ask 规则、安全路径仍然有效。 |
| `dontAsk` | 计算方式和 `default` 相同。最后如果结果是提问，改成拒绝。 |

已有写法继续可用：`--permission-mode bypass` 和 `--dangerously-skip-permissions` 都等于 `bypassPermissions`。`/mode` 接受上表里的名字，也接受 `bypass`。

启动时的模式：命令行优先，其次是设置里的 `permissions.defaultMode`，再其次是 `default`。

`permissions.disableBypassPermissionsMode` 设为 `"disable"` 时，`bypassPermissions` 和 `--dangerously-skip-permissions` 直接报错退出。

## 判断顺序

每一次工具调用都按这个顺序，命中就停。

1. 整类工具的 `deny`。例如 `Bash`、`Bash(*)`。
2. 整类工具的 `ask`。例如 `Bash`。这里命中就要问，`bypassPermissions` 不能跳过。
3. 带内容的 `deny`。例如 `Bash(rm:*)`、`Edit(.env)`。
4. 带内容的 `ask`。例如 `Bash(git push:*)`。`bypassPermissions` 不能跳过。
5. 安全路径。目标落在 `.git/**`、`.ccc/**`、`.vscode/**`，或是 shell 启动文件（`.bashrc`、`.zshrc`、`.zprofile`、`.profile`、`.bash_profile`）时，改成提问。`bypassPermissions` 不能跳过。`plan` 和 `dontAsk` 下这一步变成拒绝。
6. `bypassPermissions` 放行。
7. 整类工具的 `allow`。
8. 带内容的 `allow`。例如 `Bash(npm test:*)`、`Edit(src/**)`。
9. 模式默认值。`Read`、`Glob`、`Grep` 放行。`acceptEdits` 再放行工作区内的 `Write` 和 `Edit`。`plan` 拒绝其余操作。
10. `dontAsk` 把仍然要问的结果改成拒绝。
11. 提问。

同一调用同时匹配 `allow` 和 `deny` 时，`deny` 生效，因为它排在前面。

## 规则写法

```text
Bash
Bash(*)
Bash(npm test:*)
Bash(git push)
Read
Edit(src/**)
Write(.env)
```

- 只有工具名、`Tool(*)` 或 `Tool()`：匹配这类工具的全部调用。
- `Bash(前缀:*)`：命令去掉首尾空白后，等于这个前缀，或后面跟着空格。`Bash(npm test:*)` 匹配 `npm test` 和 `npm test --watch`，不匹配 `npm testing`。
- `Bash(完整命令)`：没有 `:*` 时，整条命令必须相同。
- 文件类规则括号里是路径 glob。`Edit(src/**)` 匹配 `src/a.ts`。路径相对于当前工作目录。

工具名和内部工具的对应：

| 规则名 | 内部工具 |
| --- | --- |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Edit` | `edit_file` |
| `Glob` | `glob` |
| `Grep` | `grep` |
| `Bash` | `bash` |

内部名字也可以写进规则，例如 `read_file`。大小写不敏感。

## 配置文件

三份文件合并。任一份里的 `deny` 或 `ask` 都生效。

| 文件 | 作用 |
| --- | --- |
| `~/.ccc/settings.json` | 用户自己的规则，所有项目共用 |
| `<工作目录>/.ccc/settings.json` | 项目规则，可以提交 |
| `<工作目录>/.ccc/settings.local.json` | 这台机器的项目规则，加入 `.gitignore` |

文件不存在就跳过。JSON 无法解析，或某条规则写错，启动时报出文件路径和那条规则，然后退出。

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Read"],
    "deny": ["Bash(rm:*)"],
    "ask": ["Bash(git push:*)"],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable"
  }
}
```

`disableBypassPermissionsMode` 可以省略。省略表示允许进入 bypass。

命令行追加的规则只活在这一次进程里：

```bash
ccc --allowed-tools 'Bash(npm test:*)' --disallowed-tools 'Bash(rm:*)'
```

两个参数都可以重复，或用逗号分隔多条。

## 终端里的四种回答

需要提问时打印工具名和参数摘要，然后等待：

| 输入 | 结果 |
| --- | --- |
| `1` 或 `y` | 只允许这一次 |
| `2` | 本会话允许。规则留在内存里，退出就没了 |
| `3` | 把同样的规则追加到 `.ccc/settings.local.json` 的 `allow` |
| `4` 或 `n` | 拒绝。模型收到一条 permission denied 的工具结果 |

`2` 和 `3` 保存的是这一次调用对应的具体规则，不是整类工具。命令 `npm test --watch` 存成 `Bash(npm test:*)`。改文件存成带这次路径的规则，例如 `Edit(src/permissions.ts)`。取命令前缀时，去掉最后一段看起来像参数的内容（以 `-` 开头，或含 `=`）。整条命令只剩一个词时，就用这一个词。

非交互的 `-p` 如果算出来要提问，按拒绝处理，并在 stderr 说明需要规则、`acceptEdits` 或 `bypassPermissions`。

## 测试

实现时补这些用例：

- `deny` 压过 `allow`，也压过 `bypassPermissions`。
- `ask` 规则和安全路径在 `bypassPermissions` 下仍然提问。
- `Bash(npm test:*)` 的前缀边界。
- `acceptEdits` 放行工作区内的 `Edit`，命令仍会提问。
- `plan` 拒绝 `Bash`。
- `dontAsk` 把本来要问的 `Bash` 变成拒绝。
- `settings.local.json` 不存在时正常启动；JSON 损坏时启动失败。
- 选 `3` 之后，同一条规则写入本地文件，下一次调用不再问。

## 审批

同意这份文档之后再写代码。要改判断顺序、规则写法、保存位置或四种回答，直接指出哪一节。
