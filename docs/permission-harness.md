# 权限 harness 设计

状态：修订稿，待审批。这份文档通过之前，不改权限代码。

这一轮把 `ccc` 的工具权限做成和 Claude Code 同一套判断方式，包括 `auto` 模式和每个工具自己的检查。配置放在我们自己的 `.ccc`，不读取、不写入 `~/.claude` 或项目里的 `.claude`。

## 现在已经有的

`src/permissions.ts` 里的 `PermissionGate` 只有四种模式：`default`、`acceptEdits`、`plan`、`bypass`。读文件直接放行，改文件和命令会问。回答是允许、拒绝，或本会话记住整个工具名。没有规则文件，也没有按路径和命令再查一遍。`bypass` 会跳过后面的所有检查。

## 这一轮做什么

1. 外层按「判断顺序」决定允许、拒绝、交给 `auto`，或提问。
2. 每个工具先做自己的检查。外层规则和模式不能代替这一节。
3. 从用户设置和项目本地设置加载规则。项目可提交的设置只提供 `allow`、`deny`、`ask` 和 `defaultMode`。
4. 终端里每次提问给四个选择：允许一次、本会话允许、写入本地设置、拒绝。
5. 命令行可以用 `--allowed-tools` 和 `--disallowed-tools` 追加规则。
6. `auto` 在本来要提问时，用同一个模型接口再判一次。

## 这一轮不做什么

- 不做沙箱。沙箱里的命令不会因为开了沙箱就自动放行。
- 不做 PreToolUse 这类 hooks。
- 不做网页上的权限卡片。`src/server` 和 `src/web` 先保持未提交，不在这一轮接上。
- 不增加额外工作目录。允许范围就是启动时的工作目录。
- 不接企业策略下发。
- 不做 tree-sitter 命令解析。命令拆分用下面写的规则。
- 不做 `Bash(prompt:一段自然语言)` 这种再调模型去匹配描述的规则。`auto` 是唯一会为了权限再调模型的地方。

## 模式

| 模式 | 行为 |
| --- | --- |
| `default` | 工作区内的读和搜索放行。改文件、命令，以及工作区外的读，没有规则时提问。 |
| `acceptEdits` | 工作区内、并且通过安全路径检查的 `Write` 和 `Edit` 放行。命令仍按 Bash 自检和提问处理。 |
| `plan` | 只放行工作区内的 `Read`、`Glob`、`Grep`。改文件和命令直接拒绝，不提问，也不进 `auto`。 |
| `bypassPermissions` | 工具自检没有拒绝、没有 ask 规则、也没有安全路径命中时放行。 |
| `dontAsk` | 和 `default` 用同一套检查。最后如果结果是提问，改成拒绝。不进 `auto`。 |
| `auto` | 先走和 `default` 相同的检查。结果已经是允许或拒绝就停。结果是提问时，再走「auto 模式」。 |

已有写法继续可用：`--permission-mode bypass` 和 `--dangerously-skip-permissions` 都等于 `bypassPermissions`。`/mode` 接受上表里的名字，也接受 `bypass`。

启动时的模式：命令行优先，其次是设置里的 `permissions.defaultMode`，再其次是 `default`。

`permissions.disableBypassPermissionsMode` 设为 `"disable"` 时，进入 `bypassPermissions` 直接报错退出。`permissions.disableAutoMode` 设为 `"disable"` 时，进入 `auto` 同样报错退出。这两个开关只认用户设置和项目本地设置，不认可提交的项目设置。

## 判断顺序

每一次工具调用都按这个顺序，命中就停。第 3 步会进入对应工具的自检；自检自己还有顺序，见下一节。

1. 整类工具的 `deny`。例如 `Bash`、`Bash(*)`。
2. 整类工具的 `ask`。例如 `ask` 列表里的 `Bash`。这里命中就要问，`bypassPermissions` 和 `auto` 都不能跳过。`dontAsk` 把它变成拒绝。
3. 工具自检。自检可以返回允许、拒绝或提问。
4. 安全路径如果在自检里返回提问，`bypassPermissions` 不能把它改成允许。`dontAsk` 把它变成拒绝。`auto` 只处理标成「分类器可以判」的安全路径；Windows 可疑路径保持提问。
5. `bypassPermissions` 放行。这一步只在自检没有拒绝、没有 ask 规则、也没有安全路径命中时到达。
6. `dontAsk` 把仍然要问的结果改成拒绝。
7. `auto` 处理仍然要问的结果。规则见「auto 模式」。
8. 提问。

同一调用同时匹配 `allow` 和 `deny` 时，`deny` 生效，因为它在自检里排在前面。

## 工具自检

路径先做成绝对路径，再解析符号链接。原路径和链接目标都要查。链接目标落在工作区外或危险文件上时，按目标处理。比较时忽略大小写，避免 `.GiT` 这类绕过。`//` 和 `\\` 开头的 UNC 路径直接提问，不读盘。

### Read、Glob、Grep

这三类走同一套读检查。`Glob` 和 `Grep` 的路径用参数 `path`，省略时当作工作目录。

1. UNC 路径，或 Windows 可疑路径（NTFS 交替数据流、`\\?\` 长路径前缀、8.3 短名、结尾点或空格、连续三个以上的点）：提问。`auto` 不能改这个决定。
2. 命中读的 `deny` 规则：拒绝。写的允许规则不能反过来打开一个被读拒绝的路径。
3. 命中读的 `ask` 规则：提问。
4. 这个路径如果按写检查会允许，读也允许。有写权限就有读权限，但第 2、3 步优先。
5. 路径在工作目录内：允许。
6. 命中读的 `allow` 规则：允许。
7. 其余情况，包括工作目录外的路径：提问。

### Write、Edit

1. 原路径和链接目标命中写的 `deny` 规则：拒绝。
2. 安全路径，在任何 `allow` 规则之前检查，避免一条宽规则悄悄打开这些文件：
   - Windows 可疑路径：提问。`auto` 不能批准。
   - 目录名是 `.git`、`.vscode`、`.idea`、`.claude`、`.ccc` 的任意一层：提问。`auto` 可以批准。
   - 文件名是 `.gitconfig`、`.gitmodules`、`.bashrc`、`.bash_profile`、`.zshrc`、`.zprofile`、`.profile`、`.ripgreprc`、`.mcp.json`、`.claude.json`：提问。`auto` 可以批准。
3. 本会话的 `allow` 可以单独打开 `.ccc/**`。用户设置和项目设置里的 `Edit(.ccc/**)` 不能跳过第 2 步。这样「本会话允许」能改自己的本地设置，又不会被一份永久宽规则把整个 `.ccc` 打开。
4. 命中写的 `ask` 规则：提问。
5. 模式是 `acceptEdits`，路径在工作目录内，并且没有被上面几步拦住：允许。
6. 命中写的 `allow` 规则：允许。
7. 其余情况：提问。工作目录外的路径在原因里标明是目录范围。

`acceptEdits` 不会跳过第 1 到第 4 步。

### Bash

先把命令拆开，再对每一段做规则匹配。

1. 引号不配对，或出现命令替换（反引号、`$(...)`）和进程替换（`<(...)`、`>(...)`）：先查有没有整条命令的精确 `deny`。有就拒绝，没有就提问。前缀允许不能盖过这种命令。
2. 用 `&&`、`||`、`;`、`|`、`&` 和换行拆成多段。每一段单独匹配。`Bash(cd:*)` 不匹配 `cd /tmp && rm -rf /`。
3. 重定向 `>`、`>>` 的目标路径按 `Write` 的安全路径和工作目录规则检查。匹配前缀时可以先拿掉重定向，但目标路径仍然要查。`echo hi > .git/config` 不能因为 `echo` 看起来无害就放行。
4. 每一段先查精确 `deny`，再查前缀 `deny`，再查精确 `ask` 和前缀 `ask`，再查精确 `allow` 和前缀 `allow`。
5. `Bash(前缀:*)` 只匹配一段命令。命令去掉首尾空白后等于这个前缀，或后面是空格。`Bash(npm test:*)` 匹配 `npm test` 和 `npm test --watch`，不匹配 `npm testing`。
6. 没有 `:*` 的 `Bash(完整命令)` 必须和那一段整段相同。
7. `cd` 的目标在工作目录外：提问。
8. 每一段都允许，并且重定向目标也允许：整条命令允许。有一段要问：整条提问。有一段被拒绝：整条拒绝。

保存「本会话允许」或「写入本地设置」时，用稳定前缀：`git commit -m "fix"` 存成 `Bash(git commit:*)`。第二个词如果是 flag、路径或数字，就退回整段精确命令，例如 `ls -la` 存成 `Bash(ls -la)`。命令前面的环境变量赋值不放进前缀。

## auto 模式

只有第 7 步才会进到这里。前面已经拒绝或允许的调用不再调模型。

1. 安全路径标成「分类器不能判」的，保持提问。目前只有 Windows 可疑路径。
2. 把模式临时看成 `acceptEdits` 再跑一次这个工具的自检。自检允许的话，直接允许，不再调分类器。工作区内的普通 `Edit` 和 `Write` 走这条。
3. `Read`、`Glob`、`Grep` 直接允许。这三条如果能走到提问，通常是工作区外的读；`auto` 仍然放行。`deny` 在前面已经处理过。
4. 其余提问，主要是 `Bash` 和被安全路径拦住的写，调用分类器。
5. 分类器用当前对话里的用户消息、助手文本和这次工具调用，外加 `autoMode.allow` 与 `autoMode.soft_deny`。它只回答允许或拒绝，并给一句理由。
6. 分类器允许：放行。连续拒绝次数清零。
7. 分类器拒绝：拒绝，并把理由写进工具结果。连续拒绝加 1，累计拒绝加 1。
8. 连续拒绝达到 3 次，或累计拒绝达到 20 次：不再自动拒绝，改成提问，提问内容带上分类器的理由。用户一旦允许，连续拒绝清零。
9. 分类器请求失败或超时：拒绝。这一轮选择失败即关闭，不退回普通提问。
10. 送给分类器的记录过长：改成提问。`-p` 这种不能提问的运行里改成拒绝。

`autoMode` 只从 `~/.ccc/settings.json` 和 `<工作目录>/.ccc/settings.local.json` 读取。可提交的 `.ccc/settings.json` 里的 `autoMode` 忽略。项目仓库不能自己规定哪些命令算安全。

```json
{
  "autoMode": {
    "allow": ["运行这个仓库的测试"],
    "soft_deny": ["推送到远程", "删除工作目录以外的文件"]
  }
}
```

`allow` 和 `soft_deny` 是给分类器的说明，不是 `Bash(npm test:*)` 那种硬规则。硬规则仍然走 `permissions.allow` 和 `permissions.deny`，并且在分类器之前生效。

分类器使用和主对话相同的接口与密钥。模型可以用 `AUTO_MODEL` 单独指定，不指定就用主模型。提示词写在我们自己的代码里，说明它只判断这一次工具调用是否超出用户刚说的任务，拒绝破坏性、外传和权限扩大的操作。

## 规则写法

```text
Bash
Bash(*)
Bash(npm test:*)
Bash(git push)
Read
Read(../secrets/**)
Edit(src/**)
Write(.env)
```

- 只有工具名、`Tool(*)` 或 `Tool()`：匹配这类工具的全部调用。
- `Bash` 的前缀和精确匹配见上一节。
- 文件类规则括号里是路径 glob。`Edit(src/**)` 匹配 `src/a.ts`。相对路径相对于工作目录，绝对路径按绝对路径匹配。

| 规则名 | 内部工具 | 自检 |
| --- | --- | --- |
| `Read` | `read_file` | 读检查 |
| `Glob` | `glob` | 读检查 |
| `Grep` | `grep` | 读检查 |
| `Write` | `write_file` | 写检查 |
| `Edit` | `edit_file` | 写检查 |
| `Bash` | `bash` | 命令拆分和重定向检查 |

内部名字也可以写进规则。大小写不敏感。

## 配置文件

| 文件 | 作用 |
| --- | --- |
| `~/.ccc/settings.json` | 用户规则和 `autoMode`，所有项目共用 |
| `<工作目录>/.ccc/settings.json` | 可提交的 `allow`、`deny`、`ask`、`defaultMode`。这里的 `autoMode` 和两个 disable 开关无效 |
| `<工作目录>/.ccc/settings.local.json` | 这台机器的规则和 `autoMode`，加入 `.gitignore` |

三份文件里的 `allow`、`deny`、`ask` 合并。任一份的 `deny` 都生效。文件不存在就跳过。JSON 无法解析，或某条硬规则写错，启动时报出文件路径和那条规则，然后退出。

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)"],
    "deny": ["Bash(rm:*)"],
    "ask": ["Bash(git push:*)"],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "disableAutoMode": "disable"
  },
  "autoMode": {
    "allow": ["运行这个仓库的测试"],
    "soft_deny": ["推送到远程"]
  }
}
```

两个 disable 开关和 `autoMode` 可以省略。

命令行追加的规则只活在这一次进程里：

```bash
ccc --allowed-tools 'Bash(npm test:*)' --disallowed-tools 'Bash(rm:*)'
```

两个参数都可以重复，或用逗号分隔多条。

## 终端里的四种回答

需要提问时打印工具名、参数摘要，以及走到提问的原因，然后等待：

| 输入 | 结果 |
| --- | --- |
| `1` 或 `y` | 只允许这一次 |
| `2` | 本会话允许。规则留在内存里，退出就没了 |
| `3` | 把同样的规则追加到 `.ccc/settings.local.json` 的 `allow` |
| `4` 或 `n` | 拒绝。模型收到一条 permission denied 的工具结果 |

`2` 和 `3` 保存这一次调用对应的具体规则。Bash 用「工具自检」里的稳定前缀或精确命令。改文件存成这次路径，例如 `Edit(src/permissions.ts)`。对 `.ccc/**` 的允许只通过 `2` 记入本会话，`3` 不把 `.ccc/**` 写进永久 allow。

非交互的 `-p` 如果算出来要提问，按拒绝处理，并在 stderr 说明需要规则、`acceptEdits`、`auto` 或 `bypassPermissions`。`auto` 在 `-p` 里仍然可以自己允许或拒绝；只有分类器不可用以外的「必须提问」才会落到这条拒绝。

## 测试

实现时补这些用例：

- `deny` 压过 `allow`，也压过 `bypassPermissions` 和 `auto`。
- 整类 `ask` 在 `bypassPermissions` 和 `auto` 下仍然提问，在 `dontAsk` 下变成拒绝。
- `.git/config` 的 `Edit` 在 `acceptEdits` 和 `bypassPermissions` 下仍然提问。
- Windows 可疑路径在 `auto` 下仍然提问。
- `.bashrc` 的写在 `auto` 下会进入分类器，而不是直接放行。
- 工作区内的普通 `Edit` 在 `auto` 下走 `acceptEdits` 捷径，不调用分类器。
- `Read`、`Glob`、`Grep` 在 `auto` 下允许，包括工作区外的读，除非有 `deny`。
- `Bash(npm test:*)` 不匹配 `npm testing`，也不匹配 `npm test && rm -rf /`。
- `echo hi > .git/config` 提问或拒绝，不能被 `echo` 的允许规则单独放行。
- 命令替换提问，精确 `deny` 仍然拒绝。
- `plan` 拒绝 `Bash` 和 `Edit`。
- 分类器拒绝累计到 3 次连续或 20 次总共后改为提问。
- 分类器请求失败时拒绝。
- 可提交的项目设置里的 `autoMode` 被忽略。
- 选 `3` 之后，同一条规则写入 `.ccc/settings.local.json`，下一次不再问。`.ccc/**` 不能通过 `3` 变成永久允许。

## 审批

同意这份修订稿之后再写代码。要改 `auto` 的失败策略、Bash 拆分，或安全路径名单，直接指出哪一节。
