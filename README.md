# pi-memory

给 Pi 的长期记忆层：内容存在文件里，不进压缩管线，跨会话保留。

Pi 的上下文满了要压缩，压缩是有损的——你在第一轮说的「用 tab 不用空格」到了第三轮可能只剩一句「用户有代码风格偏好」，新开会话连这句都没了。pi-memory 把这类事实存成 markdown 文件，用一份目录常驻 system prompt，按需把正文带回当前请求。

## 工作方式

三个环节，对应 `.agents/memory/` 下一个文件一条记忆：

| 环节 | 时机 | 做什么 |
| --- | --- | --- |
| 目录 | 每次请求 | `MEMORY.md`（一行一条：`[名称](文件) — 描述`）注入 system prompt。目录稳定，命中 prompt cache |
| 召回 | 用户提问后 | 用配置的廉价模型从目录里挑出与本次请求相关的几条，把正文追加到当前请求的尾部用户消息；模型不可用时退回关键词匹配 |
| 提取 | 一轮结束、会话空闲后 | 用廉价模型读这轮对话，把还没有记录过的稳定事实写成新文件并更新目录 |

写入的格式：

```markdown
---
name: tabs-not-spaces
description: 写代码用 tab 缩进，不用空格
type: user
---

写代码时用 tab。
**Why:** 与现有代码库保持一致。
**How to apply:** 创建或修改文件时使用 tab。
```

`type` 有四类：`user`（用户是谁）、`feedback`（该怎么做、被纠正过的做法）、`project`（项目正在发生什么）、`reference`（东西在哪找）。

## 安装

```bash
pi install npm:@fenlyin/pi-memory
# 或
pi install git:github.com/fenlyin0420/pi-memory
```

试用不写入配置：

```bash
pi -e ./path/to/pi-memory
```

## 快速开始

正常对话即可。说出稳定偏好、纠正做法、交代项目背景时，一轮结束后自动落盘；想立刻查看：

```text
/memory status      # 两个 store 各有多少条、配置文件在哪
/memory list 20
/memory search 缩进
/memory show tabs-not-spaces
/memory add         # 打开编辑器手写一条
/memory forget tabs-not-spaces
/memory auto off    # 本次会话关掉自动提取与召回
```

模型侧有两个工具：`memory_save`（保存一条事实）、`memory_search`（按词找条目、读正文）。

## 存储位置

| 范围 | 路径 | 用途 |
| --- | --- | --- |
| global | `~/.agents/memory/` | 跨项目偏好、用户画像、工具线索 |
| project | `<仓库根>/.agents/memory/` | 只属于这个仓库的事实 |

两个目录各有一份 `MEMORY.md` 索引。已有的记忆文件可以直接用——frontmatter 是 `name` / `description` / `type` 三行，旧文件里的嵌套 `metadata.type` 也仍能读；更新索引只增改对应那行，手写的描述不会被覆盖。

## 配置

读两个文件，后者覆盖前者：

- `~/.pi/agent/memory.json`
- `<cwd>/.pi/memory.json`（项目被信任时才读）

缺省值即下面的值，只需写要改的键。

```json
{
  "store": {
    "global": "~/.agents/memory",
    "project": true,
    "projectPath": ".agents/memory"
  },
  "prompt": {
    "index": true,
    "maxIndexItems": 200,
    "maxIndexBytes": 25000
  },
  "recall": {
    "enabled": true,
    "maxItems": 5,
    "maxFileBytes": 4096,
    "maxTotalBytes": 12000,
    "minPromptChars": 12,
    "useModel": true,
    "timeoutMs": 8000
  },
  "extract": {
    "enabled": true,
    "model": "opencode-go/deepseek-v4.1-flash",
    "maxMessages": 12,
    "maxDialogueChars": 6000,
    "minIntervalMs": 60000,
    "maxNewPerRun": 3,
    "skipChildSessions": true
  },
  "consolidate": {
    "enabled": false,
    "threshold": 30,
    "minIntervalMs": 86400000,
    "model": ""
  }
}
```

要点：

- `extract.model` 也是召回选择用的模型，默认 `opencode-go/deepseek-v4.1-flash`；换成任意 `<provider>/<model-id>` 都行，前提是能稳定输出 JSON。留空字符串会退回当前会话模型（费用按主模型算）。
- `prompt.maxIndexBytes` 决定目录的常驻体积。目录越大，记忆越不容易被漏掉，但每次会话要多付这部分 token（目录不变时走缓存）。超出上限时目录末尾会注明「M 条中的 N 条」，其余靠 `memory_search`。
- `extract.minIntervalMs`、`maxNewPerRun` 是费用闸门：同一进程内间隔太短不跑，一轮最多写几条。
- `recall.minPromptChars` 让「继续」「ok」这类短消息不触发召回。
- `consolidate.enabled` 默认关闭。开启后条目数超过 `threshold` 且距上次整理超过 `minIntervalMs` 时，模型会把重复或过时的记忆合并；被合并的文件先备份到 `.backup/<时间戳>/`。也可以手动跑 `/memory consolidate`，执行前会列出要合并的条目。

## 费用与隐私

- 召回与提取各有一次额外的模型调用。关掉自动提取：`extract.enabled: false`；只关召回：`recall.enabled: false`；两者都关：`/memory auto off`。
- 记忆是普通文本文件，可以用任何编辑器查看、修改、提交进 git，也可以用 `rm` 删掉。提取只写不改，删除和合并都要经过你。

## 排查

```bash
PI_MEMORY_DEBUG=1 pi
```

会在 stderr 打出召回为什么没动作、提取拿回了什么、写到了哪个文件。

## License

MIT

## Contributing

Issue 与 PR 都欢迎。改动请附带 `npm run check`（typecheck + biome + vitest）与 `npm run smoke`。
