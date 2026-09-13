# @starhikari/koishi-plugin-group-whitelist

[![npm](https://img.shields.io/npm/v/@starhikari/koishi-plugin-group-whitelist?style=flat-square)](https://www.npmjs.com/package/@starhikari/koishi-plugin-group-whitelist)

群聊白名单系统：按「平台 + 群号」维护白名单，**未命中白名单的群消息会被整只机器人静默忽略** —— 所有指令、其他插件的监听器、模糊匹配都不会触发，等同于机器人不在这个群里。

## 特性

- **全局总闸**：拦截发生在消息进入 Koishi 消息流水线的第一刻，不是逐个插件过滤
- **按平台隔离**：名单主键为「平台 + 群号」，onebot（NapCat）与 qq（官方 bot）各自独立
- **指令维护**：`白名单 添加/移除/列表`，增删均支持批量群号，数据库自动建表
- **自动降级**：未注册数据库时改用配置项 `fallbackGroups`，无需手动切换
- **私聊可控**：私聊默认放行（方便管理员在私聊里救急），可切换为禁止或私聊白名单
- **入群提示**：机器人被拉入未白名单的群时发送一次可自定义的提示文本
- **同步判定**：运行期不逐条消息查库，启动时整表载入内存判定表

## 安装

```text
# 在插件市场搜索「group-whitelist」并安装，或在终端执行
npm install @starhikari/koishi-plugin-group-whitelist
```

然后在 `koishi.yml` 中启用（行首的 `~` 表示禁用，去掉即可）：

```yaml
plugins:
  '@starhikari/group-whitelist': {}
```

插件依赖 `database` 服务（可选）。项目里默认已有 `database-sqlite`，无需额外安装。

## 快速上手

首次启动时白名单为空，**该平台下所有群聊都会被忽略**（这正是白名单的语义）。启用某个群有两种方式：

1. **私聊机器人**（推荐，私聊默认放行）：

   ```text
   白名单.添加 123456          # 自动使用当前会话平台
   白名单.添加 123456 -p qq    # 跨平台管理时显式指定平台
   ```

2. **改配置文件**：在 `fallbackGroups` 里写上群号后重载插件（仅在未注册数据库时生效）。

## 配置项

配置在 Koishi 控制台中分组展示，不满足条件的项会自动折叠。

### 群聊白名单设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ignoreMessage` | `string` | `''` | 未命中白名单时的提示文本，留空表示完全静默 |
| `startupDelay` | `number` | `3` | 启动后等待多少秒再初始化白名单，期间拦截全部群聊请求 |
| `enableLog` | `boolean` | `false` | 是否在控制台以 `debug` 级别记录被拦截的群聊消息 |

> **为什么要等 3 秒**：数据库服务（如 `database-sqlite`）比插件启动晚约 1 秒才就绪，
> 插件若在那一刻就去读库，会读不到任何数据而误判「白名单为空」，甚至把整只机器人锁死。
> 因此启动闸门期内**一律拦截群聊请求**（fail-closed），等数据源就位后再初始化判定表。
> 私聊不受闸门影响，这段时间仍可私聊机器人执行管理指令。设为 `0` 可关闭等待。

### 管理指令权限设置

`authority`（内置权限等级）与管理员数组**两个开关独立生效，满足其一即可**使用管理指令。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `authorityCheck` | `boolean` | `true` | 启用内置 authority 检查 |
| `authorityLevel` | `number` | `3` | 最低 authority 等级。Koishi 默认用户等级为 1，因此默认只有手动提权过的人能用 |
| `adminCheck` | `boolean` | `true` | 启用管理员数组检查 |
| `adminList` | `string[]` | `[]` | 管理员用户 ID 列表（跨平台匹配） |

### 无数据库模式白名单

仅在未注册 `database` 服务时生效，支持两种写法：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `fallbackGroups` | `string[]` | `[]` | `'onebot:123456'` 限定平台；`'123456'` 对所有平台生效 |

> 该模式下指令增删不会生效，管理指令会明确提示原因。

### 私聊设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `privateChat` | `'all' \| 'whitelist' \| 'forbidden'` | `'all'` | 私聊策略 |
| `privateWhitelist` | `string[]` | `[]` | 仅 `privateChat = 'whitelist'` 时展示 |

> 不推荐使用 `forbidden`：那样管理员就没法在私聊里添加群了。

### 入群提示设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `joinNoticeEnabled` | `boolean` | `true` | 被拉入未白名单的群时发送一次提示 |
| `joinNoticeText` | `string` | `本群尚未启用机器人服务，如需启用请联系管理员。` | 提示文本（静态文本，不支持占位符） |

### 群名刷新设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `groupNameRefreshDays` | `number` | `7` | 每隔多少天自动刷新一次群名称，`0` 表示不自动刷新 |
| `groupNameBatch` | `number` | `5` | 每次并发查询的群数量；NapCat 的群信息接口有频率限制，数值过大会被风控 |

> 群名只用于 `白名单.列表` 展示，**不参与拦截判定**，因此刷新失败不会影响白名单功能。

## 指令

主指令 `白名单`（英文 `whitelist`）。`authority` 与管理员数组任一满足即可使用。

> **子指令必须用点号调用**：Koishi 的指令解析按 `.` 逐段匹配（`Commander._resolve` 里 `key.split('.')`），
> 所以写法是 `白名单.添加 123456`，而不是 `白名单 添加 123456`。
> 中文名本身就是子指令名，因此下列三种写法等价：`白名单.添加` / `whitelist.添加` / `whitelist.add`。

| 子指令 | 别名 | 说明 |
|--------|------|------|
| `白名单.列表` | `白名单.list` / `白名单.ls` / `白名单.查看` | 列出当前平台白名单，`▶` 标记当前群 |
| `白名单.添加 <群号...>` | `白名单.add` | 批量添加，空格或逗号分隔 |
| `白名单.移除 <群号...>` | `白名单.remove` / `白名单.rm` / `白名单.delete` / `白名单.删除` | 批量移除 |
| `白名单.刷新` | `白名单.refresh` / `白名单.sync` / `白名单.同步群名` | 立刻重新拉取群名称 |

公共选项：

- `-p, --platform <name>`：指定平台，默认取当前会话所在平台（私聊里会尝试按唯一 bot 自动推断）

使用示例：

```text
白名单.列表
白名单.列表 -p qq
白名单.添加 123456 654321
白名单.添加 123456,654321
白名单.移除 123456
白名单.刷新
白名单.刷新 -p qq
```

批量操作会逐项回报结果：已添加 / 已存在跳过 / 写入失败 / 格式不正确的项分别统计。

## 群名称

OneBot 的群消息事件里**没有群名**（事件只带 `group_id`），群名必须额外调 `get_group_info`
才能拿到 —— 适配器把它接到了 `bot.getGuild()`／`bot.getChannel()` 上，这也是 `白名单.列表`
里群名显示的实现来源。官方 qq 适配器对此接口支持受限，取不到时会留空。

群名获取的三个时机：

1. **添加群时**：`白名单.添加` 会顺带抓一次群名写入数据库，列表直接读表，零额外开销；
2. **定时刷新**：按 `groupNameRefreshDays` 周期遍历所有平台的已入库群名并更新；
3. **手动刷新**：`白名单.刷新` 立刻执行一次，可用 `-p` 只刷新某个平台。

取不到名称时**保留原有值**，不会把已有数据清空；名称相同也不会产生多余的写库操作。
未注册数据库（配置模式）时没有可持久化的位置，群名改为列表展示时按需查询并缓存在内存中。

## 给其他插件用的服务

本插件按 Koishi 官方[自定义服务](https://koishi.chat/zh-CN/guide/plugin/service)的写法，
在 `package.json` 里用 `koishi.service.implements` 声明并提供一个名为 `groupWhitelist` 的服务，
控制台的插件详情中可以看到「提供以下服务」。

总闸能**自动**拦下的只有消息事件：`Processor.attach` 只挂在消息事件上，所以 `session.response`
这套机制对 notice / onebot 事件无效。像 bot-poke 这样在 `notice` 监听器里直接发言的插件，
必须自己查一下白名单：

```ts
// 1) 声明可选依赖
export const inject = { optional: ['groupWhitelist'] }

// 2) tsconfig 里让类型可见（模块增强只有被引入才会生效）
//    "types": ["node", "@starhikari/koishi-plugin-group-whitelist"]

// 3) 用否定式可选链，未装白名单插件时自动退化为「不受限制」
ctx.on('notice', async (session) => {
  if (session.subtype !== 'poke') return
  if (!ctx.groupWhitelist?.isAllowed(session)) return
  await session.send('哎呀，别戳我啦~')
})
```

> 必须写成 `!ctx.groupWhitelist?.isAllowed(session)`。若写成
> `if (ctx.groupWhitelist && !ctx.groupWhitelist.isAllowed(session)) return`，
> 当白名单插件因故未加载时会退化成「戳戳永远不回应」，与预期相反。

服务接口（本插件通过 `implements` 声明并提供 `GroupWhitelist` 服务）：

| 成员 | 说明 |
|------|------|
| `isAllowed(session)` | 当前会话所在群是否在白名单内；私聊按 `privateChat` 策略判定 |
| `isAllowedGroup(platform, groupId)` | 直接按平台 + 群号判定 |
| `refresh(platform?)` | 强制重新载入判定表 |

> 服务在**构造函数里显式 `ctx.set`**，因此 `ready` 之前就已注册，其他插件的 `inject` 不会排队等待。
> 但**判定表要等启动闸门结束才载入**，这段窗口内 `isAllowed()` 一律返回 `false`（fail-closed）。

**总闸覆盖的事件类型**：`message`、`notice`、`onebot`。入群、好友请求等管理类事件不在其中，
否则入群提示、加好友审核会被误伤。

## 权限模型

管理指令的裁决**完全由插件自己完成**（`ensureAdmin`），Koishi 内置的 `authority` 权限被刻意设为 0
（永不拦截）—— 因为内置的 `authority:N` 会先挡掉「等级不足但在管理员数组里」的用户，
双通道设计就失效了。因此：

- 开启 `authorityCheck` 时，`authority ≥ authorityLevel` 即通过；
- 开启 `adminCheck` 时，用户 ID 在 `adminList` 中即通过；
- 两者满足其一即放行；两者都关闭时管理指令对所有人开放（会在控制台警告）。

## 外部同步

判定结果常驻内存，指向由本插件维护的四个时机更新：启动载入、指令增删、事件刷新、数据库接入。

如果通过控制台、数据库工具或其他插件**绕过本插件直接改库**，触发下面的事件即可让判定表立刻同步：

```ts
ctx.emit('group-whitelist/refresh')        // 刷新所有平台
ctx.emit('group-whitelist/refresh', 'qq')  // 只刷新某个平台
```

## 行为细节

- **拦截范围**：仅消息事件。入群等通知类事件不受白名单影响（否则就没法发入群提示了）。
- **静默语义**：未命中的群不仅不回复指令，连其他插件的 `ctx.on('message')` 监听器也不会触发。
- **判定时机**：拦截在 `Processor.attach` 收尾处完成，早于任何中间件与指令解析。
- **异常兜底**：判定过程或数据库查询出错时按**放行**处理，避免白名单故障导致整只机器人失声。
- **兜底防线**：`Session.prototype.execute` 会被包一层，拦截会话即便被其他插件主动调用也不会执行指令；插件卸载时自动还原。

## 已知限制

- 名单按平台隔离，跨平台批量管理必须用 `-p` 显式指定平台。
- 启动瞬间（数据库模式下的极短冷启动窗口）若白名单尚未载入，该条消息会被拦截而不是放行 —— 这是刻意选择的「宁可静默也不放行」。
- 白名单为空时该平台所有群聊都会被忽略。首次启用请用私聊管理指令添加群，或改配置后重载。
