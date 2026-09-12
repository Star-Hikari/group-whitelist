import { Context, Session, Schema } from 'koishi'

export const name = 'group-whitelist'

/**
 * 数据库为可选依赖：
 * - 注册了数据库（如 database-sqlite）时，白名单存放在数据表 groupWhitelist 中，由指令动态维护；
 * - 未注册数据库时，插件自动降级为读取配置中的白名单数组（fallbackGroups），依然可正常拦截。
 */
export const inject = {
  required: [],
  optional: ['database'],
}

/** 私聊放行策略 */
export type PrivateChatMode = 'forbidden' | 'all' | 'whitelist'

export interface Config {
  /** 未命中白名单时的可选提示文本，留空表示完全静默 */
  ignoreMessage: string
  /** 启动后等待多少秒再初始化白名单，期间拦截全部群聊请求 */
  startupDelay: number
  /** 是否记录被拦截的群聊消息，用于排查问题 */
  enableLog: boolean
  /** 是否启用内置 authority 权限检查 */
  authorityCheck: boolean
  /** authority 阈值 */
  authorityLevel: number
  /** 是否启用管理员数组 */
  adminCheck: boolean
  /** 管理员用户 ID 列表 */
  adminList: string[]
  /** 无数据库模式下的白名单，支持 '平台:群号' 或仅群号（匹配任意平台） */
  fallbackGroups: string[]
  /** 私聊策略 */
  privateChat: PrivateChatMode
  /** 私聊白名单用户 ID */
  privateWhitelist: string[]
  /** 是否在机器人入群时发送提示 */
  joinNoticeEnabled: boolean
  /** 入群提示文本（静态文本） */
  joinNoticeText: string
  /** 群名自动刷新间隔（天），0 表示不自动刷新 */
  groupNameRefreshDays: number
  /** 群名刷新时每次并发查询的群数量 */
  groupNameBatch: number
}

export const Config: Schema<Config> = Schema.intersect([
  // ==================== 群聊白名单设置 ====================
  Schema.object({
    ignoreMessage: Schema.string().default('').description('未命中白名单时的提示文本，留空表示完全静默（不推荐填写，容易在陌生群刷屏）'),
    startupDelay: Schema.number().min(0).max(60).default(3).description('启动后等待多少秒再初始化白名单。这段时间内会拦截全部群聊请求，用于等数据库等服务就绪（数据库可能比插件启动晚约 1 秒）'),
    enableLog: Schema.boolean().default(false).description('是否在控制台记录被拦截的群聊消息（logger 名称为 group-whitelist，级别 debug）'),
  }).description('群聊白名单设置'),

  // ==================== 管理指令权限设置 ====================
  Schema.intersect([
    Schema.object({
      authorityCheck: Schema.boolean().default(true).description('启用内置 authority 权限检查（Koishi 用户自带的权限等级）'),
      adminCheck: Schema.boolean().default(true).description('启用管理员数组检查（与内置 permission 无关，独立生效）'),
    }).description('管理指令权限设置'),

    // 仅在启用内置权限检查时展示阈值
    Schema.union([
      Schema.object({
        authorityCheck: Schema.const(true).required(),
        authorityLevel: Schema.number().min(0).max(5).default(3).description('使用管理指令所需的最低 authority 等级。Koishi 默认用户等级为 1，所以默认只有手动提权过的人能用'),
      }),
      Schema.object({}),
    ]),

    // 仅在启用管理员数组时展示名单
    Schema.union([
      Schema.object({
        adminCheck: Schema.const(true).required(),
        adminList: Schema.array(Schema.string()).default([]).description('管理员用户 ID 列表，可跨平台，与 authority 满足其一即可使用管理指令'),
      }),
      Schema.object({}),
    ]),
  ]),

  // ==================== 无数据库模式白名单 ====================
  Schema.object({
    fallbackGroups: Schema.array(Schema.string()).default([]).description('未注册数据库时使用的白名单。格式为「平台:群号」或仅「群号」（仅写群号则对所有平台生效）'),
  }).description('无数据库模式白名单（仅在未注册数据库时生效）'),

  // ==================== 私聊设置 ====================
  Schema.intersect([
    Schema.object({
      privateChat: Schema.union([
        Schema.const('all').description('放行所有私聊'),
        Schema.const('whitelist').description('仅放行私聊白名单中的用户'),
        Schema.const('forbidden').description('禁止一切私聊（不推荐，管理员将无法在私聊中使用管理指令）'),
      ]).role('radio').default('all').description('私聊消息的处理策略'),
    }).description('私聊设置'),

    Schema.union([
      Schema.object({
        privateChat: Schema.const('whitelist').required(),
        privateWhitelist: Schema.array(Schema.string()).default([]).description('允许私聊的用户 ID 列表（跨平台匹配）'),
      }),
      Schema.object({}),
    ]),
  ]),

  // ==================== 入群提示设置 ====================
  Schema.intersect([
    Schema.object({
      joinNoticeEnabled: Schema.boolean().default(true).description('机器人被拉入新群且该群不在白名单时，在群里发送一次提示'),
    }).description('入群提示设置'),

    Schema.union([
      Schema.object({
        joinNoticeEnabled: Schema.const(true).required(),
        joinNoticeText: Schema.string().role('textarea').default('本群尚未启用机器人服务，如需启用请联系管理员。').description('入群提示文本（静态文本，不支持占位符）'),
      }),
      Schema.object({}),
    ]),
  ]),

  // ==================== 群名刷新设置 ====================
  Schema.intersect([
    Schema.object({
      groupNameRefreshDays: Schema.number().min(0).max(365).default(7).description('每隔多少天自动刷新一次白名单群的群名称，0 表示不自动刷新（群名只用于展示，不影响拦截判定）'),
    }).description('群名刷新设置'),

    Schema.union([
      Schema.object({
        groupNameRefreshDays: Schema.const(0),
      }),
      Schema.object({
        groupNameBatch: Schema.number().min(1).max(20).default(5).description('每次并发查询的群数量。NapCat 的获取群信息接口有频率限制，数值过大可能被风控'),
      }),
    ]),
  ]),
]) as unknown as Schema<Config>

// ==================== 数据库模型 ====================

declare module 'koishi' {
  interface Tables {
    groupWhitelist: GroupWhitelistEntry
  }

  interface Events {
    /** 手动刷新白名单缓存（可选传入平台名，只刷新该平台） */
    'group-whitelist/refresh'(platform?: string): void
  }
}

export interface GroupWhitelistEntry {
  /** 平台名，如 onebot / qq */
  platform: string
  /** 群号（guildId） */
  groupId: string
  /** 群名称，仅用于展示 */
  name: string
  /** 由谁添加 */
  creator: string
  /** 添加时间 */
  createdAt: Date
}

// ==================== 工具函数 ====================

/** 本地时区的可读时间 */
function formatTime(date: Date): string {
  const time = new Date(date)
  if (Number.isNaN(time.getTime())) return '未知时间'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/** 解析用户输入的群号，过滤非法项并去重 */
function parseGroupIds(digits: string[]): { valid: string[], invalid: string[] } {
  const invalid: string[] = []
  const valid: string[] = []
  for (const item of digits) {
    for (const raw of String(item).split(/[,\uFF0C\u3001;；\s]+/)) {
      const id = raw.trim()
      if (!id) continue
      if (!/^\d{1,20}$/.test(id)) {
        if (!invalid.includes(id)) invalid.push(id)
        continue
      }
      if (!valid.includes(id)) valid.push(id)
    }
  }
  return { valid, invalid }
}

/** 解析配置里的白名单项 */
function parseFallbackItem(source: string): { platform?: string, groupId: string } | null {
  const item = source.trim()
  if (!item) return null
  const colon = item.indexOf(':')
  if (colon >= 0) {
    const platform = item.slice(0, colon).trim()
    const groupId = item.slice(colon + 1).trim()
    if (platform && /^\d{1,20}$/.test(groupId)) return { platform, groupId }
    return null
  }
  return /^\d{1,20}$/.test(item) ? { groupId: item } : null
}

// ==================== 插件入口 ====================

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('group-whitelist')

  const TABLE = 'groupWhitelist' as const

  /**
   * 当前可用的数据库实例，由下方的 ctx.inject 赋值。
   * 注意：不能在 apply() 里直接判断 ctx.database —— 插件是按加载顺序同步执行的，
   * 数据库插件（如 database-sqlite）此时可能还没开始加载，直接读会永远拿到 undefined。
   * 因此这里做动态探测：服务可用时注入，服务消失时自动卸载，并清空缓存。
   */
  let db: Context['database'] | null = null

  // ---------- 异步判定（用于入群提示等非消息事件） ----------
  /**
   * 判断某个群是否在白名单内。
   * 数据库模式下会先确保该平台白名单已载入判定表，再同步读取，因此不会逐群查库。
   */
  async function isGroupAllowed(platform: string, groupId: string): Promise<boolean> {
    try {
      await ensurePlatformLoaded(platform)
    } catch (error) {
      // 查询失败时放行，避免因数据库异常导致整只机器人在所有群失声
      logger.warn('查询白名单失败，本条消息按放行处理：%s', error instanceof Error ? error.message : error)
      return true
    }
    return isGroupAllowedSync(platform, groupId)
  }

  // ---------- 权限校验 ----------
  /**
   * 取用户权限等级。
   * 注意：session.user 只有在数据库可用（且被 observe 过）时才存在，
   * 因此这里显式 observe 一次，保证自定义检查与 Koishi 自带权限系统看到同一份数据。
   */
  /**
   * 取用户权限等级。
   * 注意：session.user 只有在数据库可用（且被 observe 过）时才存在，
   * 因此这里显式 observe 一次，保证自定义检查与 Koishi 自带权限系统看到同一份数据。
   * 查询失败（例如用户记录尚不存在）时回落到 Koishi 的 autoAuthorize 默认等级，
   * 而不是直接判定为 0 —— 否则管理员数组会因为没有用户记录而失效。
   */
  async function getAuthority(session: Session): Promise<number> {
    if (!db) return 0
    try {
      const user = await session.observeUser(['authority'])
      return user?.authority ?? 0
    } catch (error) {
      logger.warn('读取用户权限失败，按默认等级处理：%s', error instanceof Error ? error.message : error)
      return ctx.root.config?.autoAuthorize ?? 1
    }
  }

  /**
   * 判断是否有权使用管理指令。
   * authority 与管理员数组分别由开关控制，任一通过即放行。
   */
  async function isAdmin(session: Session): Promise<boolean> {
    if (config.authorityCheck) {
      if (await getAuthority(session) >= config.authorityLevel) return true
    }
    if (config.adminCheck && session.userId) {
      if (config.adminList.includes(session.userId)) return true
    }
    return false
  }

  /**
   * 统一的权限门禁。
   * - 群聊中失败时完全静默（同时屏蔽自带权限系统的提示），避免在群里刷屏；
   * - 私聊中失败时给出明确原因。
   */
  async function ensureAdmin(session: Session): Promise<boolean> {
    if (await isAdmin(session)) return true
    const hints = [
      config.authorityCheck ? `authority ≥ ${config.authorityLevel}` : '',
      config.adminCheck ? '管理员数组' : '',
    ].filter(Boolean).join(' 或 ')
    if (!hints) {
      logger.warn('authority 与管理员数组均已关闭，管理指令当前对所有人开放，建议至少开启其中一项')
      return true
    }
    if (session.isDirect) {
      await session.send(`你没有权限管理白名单（需要满足：${hints}）。`)
    }
    return false
  }

  // ---------- 目标平台推断 ----------
  function resolvePlatform(session: Session, given?: string): string | null {
    if (given) return given
    if (session.platform) return session.platform
    // 私聊场景下平台可能缺失，若同平台只有一个机器人则自动补全
    const platforms = [...new Set(ctx.bots.map(bot => bot.platform))]
    return platforms.length === 1 ? platforms[0] : null
  }

  // ---------- 群名称获取 ----------
  //
  // OneBot 的群消息事件里**没有群名**（事件只有 group_id），群名必须额外调用
  // get_group_info 获取 —— koishi-plugin-adapter-onebot 把它接到了 getGuild()／getChannel()
  // 上（两者在群场景下都走 get_group_info）。官方 qq 适配器能力受限，可能不支持。
  /** 从当前会话里直接能拿到的群名（多数平台的事件里没有，拿到就用） */
  function getEventGuildName(session: Session, groupId: string): string {
    if (session.guildId !== groupId) return ''
    return session.event?.guild?.name ?? ''
  }

  function pickBot(platform: string, selfId?: string) {
    const candidates = ctx.bots.filter(bot => bot.platform === platform)
    if (selfId) return candidates.find(bot => bot.selfId === selfId) ?? null
    return candidates[0] ?? null
  }

  /** 查询单个群的名称；失败或平台不支持时返回空串（群名只用于展示，不应影响主流程） */
  async function fetchGroupName(platform: string, groupId: string, selfId?: string): Promise<string> {
    const bot = pickBot(platform, selfId)
    if (!bot) return ''
    try {
      const guild = await bot.getGuild?.(groupId)
      return guild?.name ?? ''
    } catch (error) {
      logger.debug('获取群 %s/%s 的名称失败：%s', platform, groupId, error instanceof Error ? error.message : error)
      return ''
    }
  }

  /** 按批并发执行，避免一次打出过多 API 请求被风控 */
  async function inBatches<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = []
    for (let index = 0; index < items.length; index += size) {
      const slice = items.slice(index, index + size)
      results.push(...await Promise.all(slice.map(worker)))
    }
    return results
  }

  /**
   * 刷新白名单群的群名称。
   * @param targets 指定要刷新的群；不传则刷新全部已入库的群
   * @returns 统计信息，便于指令回报与日志
   */
  async function refreshGroupNames(targets?: { platform: string, groupId: string }[]) {
    const database = db
    if (!database) {
      return { total: 0, updated: 0, failed: 0, skipped: true }
    }

    let rows: { platform: string, groupId: string, name: string }[]
    if (targets?.length) {
      rows = []
      for (const target of targets) {
        try {
          const found = await database.get(TABLE, target, ['name'])
          if (found[0]) rows.push({ ...target, name: found[0].name })
        } catch (error) {
          logger.warn('读取群 %s/%s 失败：%s', target.platform, target.groupId, error instanceof Error ? error.message : error)
        }
      }
    } else {
      try {
        rows = await database.get(TABLE, {}, ['platform', 'groupId', 'name'])
      } catch (error) {
        logger.warn('读取白名单失败：%s', error instanceof Error ? error.message : error)
        return { total: 0, updated: 0, failed: 0, skipped: false }
      }
    }

    if (!rows.length) return { total: 0, updated: 0, failed: 0, skipped: false }

    const size = Math.max(1, Math.min(20, config.groupNameBatch ?? 5))
    const names = await inBatches(rows, size, row => fetchGroupName(row.platform, row.groupId))

    let updated = 0
    let failed = 0
    for (let index = 0; index < rows.length; ++index) {
      const row = rows[index]
      const name = names[index]
      // 查询失败或平台不支持时保留原有名称，不做覆盖，避免把已有数据清空
      if (!name) {
        failed++
        continue
      }
      if (name === row.name) continue
      try {
        await database.set(TABLE, { platform: row.platform, groupId: row.groupId }, { name } as never)
        updated++
      } catch (error) {
        logger.warn('更新群 %s/%s 的名称失败：%s', row.platform, row.groupId, error instanceof Error ? error.message : error)
        failed++
      }
    }

    logger.info('群名刷新完成：共 %d 个群，更新 %d 个，失败/不支持 %d 个', rows.length, updated, failed)
    return { total: rows.length, updated, failed, skipped: false }
  }

  // ---------- 定时刷新 ----------
  let refreshTimer: (() => void) | null = null

  function stopNameScheduler() {
    refreshTimer?.()
    refreshTimer = null
  }

  function startNameScheduler() {
    stopNameScheduler()
    const days = config.groupNameRefreshDays ?? 0
    if (!days || days <= 0) return
    const interval = days * 24 * 60 * 60 * 1000
    refreshTimer = ctx.setTimeout(async () => {
      try {
        await refreshGroupNames()
      } catch (error) {
        logger.warn('自动刷新群名失败：%s', error instanceof Error ? error.message : error)
      }
      // 递归排下一次；插件卸载时 ctx.setTimeout 注册的定时器会被自动清理
      startNameScheduler()
    }, interval)
    logger.info('群名自动刷新已启用：每 %d 天一次', days)
  }

  // ---------- 白名单读写 ----------

  /** 批量添加，返回成功/重复/失败三组结果 */
  async function addGroups(platform: string, ids: string[], session: Session) {
    const added: string[] = []
    const duplicated: string[] = []
    const failed: string[] = []

    const database = db
    if (!database) {
      return { added, duplicated, failed: ids, readonly: true as const }
    }

    const existIds = new Set<string>()
    try {
      const exist = await database.get(TABLE, { platform, groupId: { $in: ids } }, ['groupId'])
      for (const row of exist) existIds.add(row.groupId)
    } catch (error) {
      logger.warn('读取白名单失败：%s', error instanceof Error ? error.message : error)
      return { added, duplicated, failed: ids, readonly: false as const }
    }

    for (const id of ids) {
      if (existIds.has(id)) duplicated.push(id)
    }

    const pending = ids.filter(id => !existIds.has(id))
    if (pending.length) {
      // 群名的来源优先级：当前会话事件里带的群名（若平台提供）→ 调用平台 API 查询。
      // OneBot 的群消息事件不带群名，所以绝大多数情况下走的是 API 查询这条路径。
      const names = await inBatches(pending, Math.max(1, Math.min(20, config.groupNameBatch ?? 5)), async (groupId) => {
        return getEventGuildName(session, groupId) || await fetchGroupName(platform, groupId, session.selfId)
      })

      // 注意：minato 的 database.create() 只接受单条记录，传数组会被判为「缺少主键」，
      // 因此这里逐条插入；数量可控（指令批量输入），不必为此改用 upsert。
      for (let index = 0; index < pending.length; ++index) {
        const groupId = pending[index]
        try {
          await database.create(TABLE, {
            platform,
            groupId,
            name: names[index] ?? '',
            creator: session.userId,
            createdAt: new Date(),
          } as never)
          added.push(groupId)
          markAllowed(platform, groupId)
        } catch (error) {
          logger.warn('写入白名单失败（%s）：%s', groupId, error instanceof Error ? error.message : error)
          failed.push(groupId)
        }
      }
    }

    return { added, duplicated, failed, readonly: false as const }
  }

  /** 批量移除，返回被移除与不存在两组结果 */
  async function removeGroups(platform: string, ids: string[]) {
    const removed: string[] = []
    const missing: string[] = []

    const database = db
    if (!database) {
      return { removed, missing: ids, readonly: true as const }
    }

    const existIds = new Set<string>()
    try {
      const exist = await database.get(TABLE, { platform, groupId: { $in: ids } }, ['groupId'])
      for (const row of exist) existIds.add(row.groupId)
    } catch (error) {
      logger.warn('读取白名单失败：%s', error instanceof Error ? error.message : error)
      return { removed, missing: ids, readonly: false as const }
    }

    for (const id of ids) {
      if (!existIds.has(id)) missing.push(id)
    }

    if (existIds.size) {
      const targets = [...existIds]
      try {
        await database.remove(TABLE, { platform, groupId: { $in: targets } })
        for (const id of targets) {
          removed.push(id)
          allowedGroups.delete(cacheKey(platform, id))
        }
      } catch (error) {
        logger.warn('移除白名单失败：%s', error instanceof Error ? error.message : error)
        removed.length = 0
        missing.push(...targets)
      }
    }

    return { removed, missing, readonly: false as const }
  }

  // ---------- 全局总闸 ----------
  /** 本次会话的判定结果：null 表示放行，字符串表示应回复的内容（空串表示完全静默） */
  const blockedMap = new WeakMap<Session, string>()
  // ---------- 拦截判定表 ----------
  //
  // 判定表只在四个时机更新，全部受本插件控制，因此可以常驻内存：
  //   1. 平台白名单载入时（启动 / 数据库接入 / 手动刷新）；
  //   2. 指令添加群成功时；
  //   3. 指令移除群成功时；
  //   4. 触发 'group-whitelist/refresh' 事件时。
  // 数据库模式下每个平台的整表查询只发生一次，因此不存在逐条消息查库的开销。
  const allowedGroups = new Set<string>()
  const cacheKey = (platform: string, groupId: string) => `${platform}:${groupId}`
  /** 已经完整载入过白名单的平台 */
  const platformLoaded = new Set<string>()
  /** 已经就「名单为空」提示过的平台，避免反复刷日志 */
  const emptyWarned = new Set<string>()
  /** 无数据库模式下的群名缓存：只在 fallbackGroups 变化时清空，避免每次列表都打 API */
  const configNameCache = new Map<string, string>()
  /** 数据库服务是否注入过。用于区分「没有配置数据库」与「数据库还没加载完」 */
  let dbEverSeen = false
  /** 启动兜底是否已判定「确实没有数据库」 */
  let configSettled = false

  function markAllowed(platform: string, groupId: string) {
    allowedGroups.add(cacheKey(platform, groupId))
  }

  function clearDecisions() {
    configNameCache.clear()
    allowedGroups.clear()
    platformLoaded.clear()
    emptyWarned.clear()
  }

  /**
   * 数据源切换时调用：清空旧结论，并在已经启动初始化之后按新数据源重新载入。
   * 注意 **不能** 清掉 initDone —— 数据源切换时闸门必须保持常开，
   * 否则会把整只机器人短暂锁死；只有插件重新加载才会回到「未初始化」的阻塞态。
   */
  function resetDecisions() {
    clearDecisions()
    if (!initDone) return
    logger.debug('数据源已切换，重新载入白名单判定表')
    initialize().catch((error) => {
      logger.warn('按新数据源重新载入白名单失败：%s', error instanceof Error ? error.message : error)
    })
  }

  /**
   * 判定表是否已经确定下来。
   * 关键点：**不确定时绝不能拿 fallbackGroups 去填表**。
   * 数据库服务在本环境里比 ready 事件晚约 800ms 才注入（实测日志：ready 在 462586、
   * 数据库注入在 463325），若那时用空的 fallbackGroups 填表，就会误报「白名单为空」，
   * 而且这份错误结论会在名单为空时把整只机器人锁死。
   */
  function decisionsSettled(): boolean {
    return !!db || dbEverSeen || configSettled
  }

  /**
   * 一次性把某个平台的白名单读进判定表，之后所有群的判定都能同步完成。
   * - 数据库就绪：整表读一次（权威来源）；
   * - 数据库确实不存在（从未注入过、且启动兜底已确认）：用配置项 fallbackGroups 填充；
   * - 数据库可能还在加载：什么都不做，避免把错误结论固化下来。
   */
  async function ensurePlatformLoaded(platform: string): Promise<void> {
    if (platformLoaded.has(platform)) return

    const database = db
    if (!database) {
      if (!decisionsSettled()) return
      let count = 0
      for (const item of config.fallbackGroups) {
        const parsed = parseFallbackItem(item)
        if (!parsed) continue
        if (parsed.platform && parsed.platform !== platform) continue
        markAllowed(platform, parsed.groupId)
        count++
      }
      platformLoaded.add(platform)
      if (!count) markEmpty(platform)
      return
    }

    const rows = await database.get(TABLE, { platform }, ['groupId'])
    for (const row of rows) markAllowed(platform, row.groupId)
    platformLoaded.add(platform)
    if (!rows.length) markEmpty(platform)
    logger.debug('已载入 %s 平台白名单，共 %d 条', platform, rows.length)
  }

  function markEmpty(platform: string) {
    if (emptyWarned.has(platform)) return
    emptyWarned.add(platform)
    logger.info('%s 平台白名单为空，该平台所有群聊都会被忽略；可私聊机器人执行「白名单 添加 <群号> -p %s」启用', platform, platform)
  }

  /**
   * 同步判定某个群是否放行。
   * 规则：该平台白名单已载入且本群在其中才放行，名单为空同样拦截 —— 白名单的语义就是
   * 「只服务名单内的群」。首次启用时名单为空，此时可以私聊机器人执行
   * 「白名单 添加 <群号> -p <平台>」把群加进来（私聊默认放行，不受群白名单影响）。
   * 尚未载入（极少见的冷启动窗口）也按拦截处理，宁可静默也不放行。
   */
  function isGroupAllowedSync(platform: string, groupId: string): boolean {
    if (!platformLoaded.has(platform)) return false
    return allowedGroups.has(cacheKey(platform, groupId))
  }

  function resolveBlockSync(session: Session): string | null {
    const groupId = session.guildId
    if (groupId) {
      if (isGroupAllowedSync(session.platform, groupId)) return null
      if (config.enableLog) {
        logger.debug('已拦截非白名单群聊消息：%s / %s / %s', session.platform, groupId, session.userId)
      }
      return config.ignoreMessage
    }

    // 私聊：按策略放行
    if (config.privateChat === 'all') return null
    if (config.privateChat === 'whitelist') {
      if (session.userId && config.privateWhitelist.includes(session.userId)) return null
      if (config.enableLog) {
        logger.debug('已拦截非白名单私聊消息：%s / %s', session.platform, session.userId)
      }
      return ''
    }
    return ''
  }

  /**
   * 全局总闸：拦截必须是完全同步的，否则一定漏。
   *
   * Koishi 处理一条消息的顺序是：
   *   ctx.emit('message') 依次调用同步监听器 → 最后一个 Processor._handleMessage 启动
   *   中间件链 → Processor.attach 收尾时检查 session.response
   * 只要监听器里出现 await，同步阶段就会先跑完，白名单结论永远晚一步。因此：
   *
   * 1. 启动时先在 ready 事件里把所有已知平台的白名单一次性读进缓存（数据库模式的核心
   *    查询只发生在这里），因此运行期的判定可以完全同步；
   * 2. before('attach') 作为兜底再补一次载入，用于插件热重载或平台后期上线的情况 ——
   *    它只做异步准备，绝不在这里决定拦截，因为它的 async 回调不会被 emit 等待；
   * 3. 真正的判定放在 { prepend: true } 的 message 监听器里同步完成（保证排在 Koishi
   *    内部处理器之前），命中则拦截：设置 session.response 后，attach 收尾会直接消费
   *    它并返回，既不进入中间件队列，也不执行任何指令，其他插件的消息监听器一并被跳过；
   * 4. 再把 Session 原型上的 execute 包一层作为兜底，避免别的插件绕过总闸直接调用
   *    session.execute() 执行指令。
   */
  ctx.on('ready', async () => {
    for (const platform of new Set(ctx.bots.map(bot => bot.platform))) {
      await ensurePlatformLoaded(platform)
    }
  })

  ctx.before('attach', (session) => {
    // 事件类型不能用 'message' 字面量判断：Satori 会把 event.type 规范化为 'message-created'。
    // 这里改为「带用户的消息事件」判断，覆盖群聊与私聊，又不把入群等通知事件卷进来。
    if (!session.userId || !session.event) return
    if (!session.guildId) return
    ensurePlatformLoaded(session.platform).catch((error) => {
      logger.warn('载入白名单失败：%s', error instanceof Error ? error.message : error)
    })
  })

  ctx.on('message', (session) => {
    if (!session.userId || !session.event) return
    const blocked = resolveBlockSync(session)
    if (blocked === null) return
    blockedMap.set(session, blocked)
    session.response = async () => blockedMap.get(session) ?? ''
  }, { prepend: true })

  // 兜底：不允许任何绕过总闸的指令执行
  const sample = ctx.bots[0]?.session({ type: 'message' })
  const prototype = sample ? Object.getPrototypeOf(sample) as Session : null
  if (prototype && typeof prototype.execute === 'function') {
    const original = prototype.execute
    prototype.execute = function (this: Session, ...args: any[]) {
      if (blockedMap.has(this)) return Promise.resolve(blockedMap.get(this))
      return original.apply(this, args)
    }
    ctx.on('dispose', () => { prototype.execute = original })
  }

  // ---------- 入群提示 ----------
  // onebot 的 group_increase（自己入群）与 adapter-qq 的 GROUP_ADD_ROBOT 均映射为 guild-added
  ctx.on('guild-added', async (session) => {
    if (!config.joinNoticeEnabled || !config.joinNoticeText) return
    const platform = session.platform
    const groupId = session.guildId
    if (!groupId) return
    try {
      if (await isGroupAllowed(platform, groupId)) return
      await session.send(config.joinNoticeText)
    } catch (error) {
      logger.warn('发送入群提示失败：%s', error instanceof Error ? error.message : error)
    }
  })

  // ---------- 管理指令 ----------
  //
  // 关于子指令命名（重要）：
  // Koishi 的指令解析是「按 . 切分」的（Commander._resolve 里 key.split('.')），
  // 因此子指令必须用点号形式调用：白名单.添加。中文名直接作为子指令名注册，
  // 这样白名单.添加 / whitelist.添加 / whitelist.add 三种写法都能命中同一条子指令。
  //
  // 关于权限：这里刻意把指令与选项的 authority 都设为 0，让 Koishi 内置权限永远放行，
  // 真正裁决交给 ensureAdmin —— 否则内置的 authority:N 会先拦掉「不在等级但在管理员数组里」
  // 的用户，双通道设计就失效了。userFields 仍然声明，好让两边读到同一份 authority。
  //
  // showWarning: false 让权限失败在群里保持静默。
  const base = { showWarning: false, authority: 0 } as const
  const platformOption = { type: 'string' as const, authority: 0 }

  const command = ctx.command('whitelist', '群聊白名单管理', base)
    .alias('白名单')
    .usage([
      '查看与维护群聊白名单。名单按「平台 + 群号」保存，未命中白名单的群消息将被整只机器人忽略。',
      '',
      '子指令：',
      '  白名单.列表      查看白名单（别名 白名单.list / 白名单.ls）',
      '  白名单.添加      添加群聊（别名 白名单.add）',
      '  白名单.移除      移除群聊（别名 白名单.remove / 白名单.rm）',
      '  白名单.刷新      立刻重新拉取群名称（别名 白名单.refresh / 白名单.同步群名）',
      '',
      '指令选项：',
      '  -p, --platform <name>  指定平台（默认取当前会话所在平台）',
      '',
      '示例：',
      '  白名单.列表',
      '  白名单.添加 123456 654321',
      '  白名单.添加 -p qq 123456,654321',
      '  白名单.移除 123456',
      '  白名单.刷新',
    ].join('\n'))

  const list = command.subcommand('.列表', '查看白名单', base)
    .alias('.list', '.ls', '.查看')
    .option('platform', '-p <name> 指定平台', platformOption)
    .example('白名单.列表')
    .example('白名单.列表 -p qq')

  const add = command.subcommand('.添加 <...digits:string>', '添加群聊到白名单（支持批量）', base)
    .alias('.add')
    .option('platform', '-p <name> 指定平台', platformOption)
    .example('白名单.添加 123456 654321')
    .example('白名单.添加 -p qq 123456,654321')

  const remove = command.subcommand('.移除 <...digits:string>', '从白名单移除群聊（支持批量）', base)
    .alias('.remove', '.rm', '.delete', '.删除')
    .option('platform', '-p <name> 指定平台', platformOption)
    .example('白名单.移除 123456')

  const refreshNames = command.subcommand('.刷新', '立刻重新拉取白名单群的名称', base)
    .alias('.refresh', '.sync', '.同步群名')
    .option('platform', '-p <name> 指定平台', platformOption)
    .example('白名单.刷新')
    .example('白名单.刷新 -p qq')

  const commands = [command, list, add, remove, refreshNames]
  if (config.authorityCheck) {
    // 让 Koishi 自带的权限系统与本插件的检查看到同一份 authority，避免出现两套判定
    for (const item of commands) item.userFields(['authority'])
  }

  // ---------- 列表 ----------
  list.action(async ({ session, options }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return

    const platform = resolvePlatform(session, options.platform)
    if (!platform) return '无法确定要查询的平台，请使用 -p <平台名> 指定。'

    let rows: GroupWhitelistEntry[] = []
    let fromConfig = false

    const database = db
    if (database) {
      try {
        rows = await database.get(TABLE, { platform }, { sort: { createdAt: 'asc' }, limit: 201 })
      } catch (error) {
        logger.warn('查询白名单失败：%s', error instanceof Error ? error.message : error)
        return '查询白名单失败，请查看控制台日志。'
      }
    } else {
      fromConfig = true
      for (const item of config.fallbackGroups) {
        const parsed = parseFallbackItem(item)
        if (!parsed) continue
        if (parsed.platform && parsed.platform !== platform) continue
        rows.push({ platform, groupId: parsed.groupId, name: '', creator: '', createdAt: new Date(0) })
      }
      rows.sort((a, b) => a.groupId.localeCompare(b.groupId))
    }

    const lines = [`${platform} 平台白名单（共 ${rows.length} 条${fromConfig ? '，来自配置项' : ''}）`]
    if (!rows.length) {
      lines.push('（名单为空，当前该平台下所有群聊消息都会被忽略）')
    } else {
      // 配置模式没有数据库可存群名，这里按需查询并缓存在内存里
      if (fromConfig) {
        await inBatches(rows, Math.max(1, Math.min(20, config.groupNameBatch ?? 5)), async (row) => {
          const key = cacheKey(platform, row.groupId)
          if (!configNameCache.has(key)) {
            configNameCache.set(key, await fetchGroupName(platform, row.groupId, session.selfId))
          }
          row.name = configNameCache.get(key) ?? ''
        })
      }
      const limit = 20
      for (const row of rows.slice(0, limit)) {
        const isSelf = !!session.guildId && row.groupId === session.guildId
        const since = row.createdAt && row.createdAt.getTime() > 0 ? `｜${formatTime(row.createdAt)}` : ''
        lines.push(`${isSelf ? '▶' : '·'} ${row.groupId}${row.name ? `（${row.name}）` : ''}${since}`)
      }
      if (rows.length > limit) lines.push(`…… 其余 ${rows.length - limit} 条已省略`)
    }
    if (fromConfig) {
      lines.push('提示：当前未注册数据库，白名单来自配置项 fallbackGroups，指令增删不会生效。')
    }
    return lines.join('\n')
  })

  // ---------- 添加 ----------
  add.action(async ({ session, options, args }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return

    const platform = resolvePlatform(session, options.platform)
    if (!platform) return '无法确定要操作的平台，请使用 -p <平台名> 指定。'

    const { valid, invalid } = parseGroupIds(args)
    if (!valid.length) {
      return invalid.length
        ? `群号格式不正确：${invalid.join('、')}。群号应为纯数字，可一次填写多个（空格或逗号分隔）。`
        : '请提供至少一个群号，例如：白名单 添加 123456'
    }

    const result = await addGroups(platform, valid, session)
    if (result.readonly) {
      return '当前未注册数据库，白名单来自配置项 fallbackGroups，无法通过指令添加。请先在配置中维护，或安装 database-sqlite 等数据库插件。'
    }

    const lines: string[] = []
    if (result.added.length) {
      lines.push(`已向 ${platform} 平台添加 ${result.added.length} 个群：${result.added.join('、')}`)
    }
    if (result.duplicated.length) {
      const preview = result.duplicated.slice(0, 5).join('、')
      lines.push(`${result.duplicated.length} 个群已在白名单中，已跳过：${preview}${result.duplicated.length > 5 ? ' 等' : ''}`)
    }
    if (result.failed.length) {
      const preview = result.failed.slice(0, 5).join('、')
      lines.push(`${result.failed.length} 个群写入失败：${preview}${result.failed.length > 5 ? ' 等' : ''}`)
    }
    if (!lines.length) return '没有需要添加的群。'
    if (invalid.length) lines.push(`另有格式不正确的项已忽略：${invalid.join('、')}`)
    return lines.join('\n')
  })

  // ---------- 移除 ----------
  remove.action(async ({ session, options, args }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return

    const platform = resolvePlatform(session, options.platform)
    if (!platform) return '无法确定要操作的平台，请使用 -p <平台名> 指定。'

    const { valid, invalid } = parseGroupIds(args)
    if (!valid.length) {
      return invalid.length
        ? `群号格式不正确：${invalid.join('、')}。群号应为纯数字，可一次填写多个（空格或逗号分隔）。`
        : '请提供至少一个群号，例如：白名单 移除 123456'
    }

    const result = await removeGroups(platform, valid)
    if (result.readonly) {
      return '当前未注册数据库，白名单来自配置项 fallbackGroups，无法通过指令移除。请直接在配置中维护。'
    }

    const lines: string[] = []
    if (result.removed.length) {
      lines.push(`已从 ${platform} 平台移除 ${result.removed.length} 个群：${result.removed.join('、')}`)
    }
    if (result.missing.length) {
      const preview = result.missing.slice(0, 5).join('、')
      lines.push(`${result.missing.length} 个群不在白名单中，已跳过：${preview}${result.missing.length > 5 ? ' 等' : ''}`)
    }
    if (!lines.length) return '没有需要移除的群。'
    if (invalid.length) lines.push(`另有格式不正确的项已忽略：${invalid.join('、')}`)
    if (result.removed.some(id => id === session.guildId)) {
      lines.push('注意：本群已被移出白名单，接下来本群消息将不再被处理。')
    }
    return lines.join('\n')
  })

  // ---------- 刷新群名 ----------
  refreshNames.action(async ({ session, options }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return

    if (!db) {
      return '当前未注册数据库，白名单来自配置项 fallbackGroups，没有可刷新的群名记录。'
    }

    // 指定平台时只刷新该平台的群，否则刷新全部
    const platform = options.platform ?? undefined
    let targets: { platform: string, groupId: string }[] | undefined
    if (platform) {
      try {
        const rows = await db.get(TABLE, { platform }, ['groupId'])
        targets = rows.map(row => ({ platform, groupId: row.groupId }))
      } catch (error) {
        logger.warn('读取白名单失败：%s', error instanceof Error ? error.message : error)
        return '读取白名单失败，请查看控制台日志。'
      }
      if (!targets.length) return `${platform} 平台白名单为空，没有需要刷新的群。`
    }

    await session.send('正在拉取群名称，请稍候…')
    const result = await refreshGroupNames(targets)

    const scope = platform ? `${platform} 平台` : '全部平台'
    const lines = [`群名刷新完成（${scope}）：共 ${result.total} 个群。`]
    if (result.updated) lines.push(`已更新 ${result.updated} 个群的名称。`)
    if (result.failed) lines.push(`${result.failed} 个群未能取到名称，已保留原值（多为平台不支持或接口异常）。`)
    if (!result.updated && !result.failed) lines.push('所有群名都是最新的，无需更新。')
    return lines.join('\n')
  })

  // ---------- 数据库接入 ----------
  // 服务可用时注入：建表 + 打开数据库模式；服务被卸载时自动回收，并清空缓存回落到配置模式
  ctx.inject(['database'], (ctx) => {
    db = ctx.database
    dbEverSeen = true
    // 平台 + 群号 复合主键，天然去重
    ctx.model.extend('groupWhitelist', {
      platform: 'string',
      groupId: 'string',
      name: { type: 'string', initial: '' },
      creator: { type: 'string', initial: '' },
      // 注意：minato 的 initial 只接受字面值、不接受工厂函数，时间戳在插入时显式赋值
      createdAt: 'timestamp',
    }, {
      primary: ['platform', 'groupId'],
      indexes: ['platform'],
    })
    resetDecisions()
    logger.info('白名单存储：数据库（表 %s）', TABLE)
    ctx.on('dispose', () => {
      db = null
      resetDecisions()
      logger.info('数据库服务已卸载，白名单回落到配置模式（fallbackGroups）')
    })
  })

  // ---------- 对外接口 ----------
  /**
   * 强制重新载入白名单判定表。
   * 运行期的判定完全依赖内存表，因此如果通过控制台、数据库工具或其他插件绕过本插件
   * 的指令直接改库，可以触发自定义事件 'group-whitelist/refresh' 让它立刻同步。
   */
  async function refresh(platform?: string): Promise<void> {
    if (platform) {
      platformLoaded.delete(platform)
      emptyWarned.delete(platform)
      for (const key of [...allowedGroups]) {
        if (key.startsWith(platform + ':')) allowedGroups.delete(key)
      }
      return ensurePlatformLoaded(platform)
    }
    clearDecisions()
    for (const item of new Set(ctx.bots.map(bot => bot.platform))) {
      await ensurePlatformLoaded(item)
    }
  }

  ctx.on('group-whitelist/refresh', (platform?: string) => {
    refresh(platform).catch((error) => {
      logger.warn('刷新白名单判定表失败：%s', error instanceof Error ? error.message : error)
    })
  })

  ctx.on('dispose', () => {
    clearDecisions()
    initDone = false
    stopNameScheduler()
  })

  // ---------- 启动闸门 ----------
  //
  // 为什么需要它：数据库服务比 ready 事件晚到（实测本环境相差接近 1 秒，且不保证上限），
  // 如果在这段时间就用配置兜底数据得结论，就会误报「平台白名单为空」，更糟的是
  // 这份结论会被固化进判定表，把整只机器人锁死。
  //
  // 因此启动后先等 startupDelay 秒（默认 3 秒）让数据库等服务就位，这段时间内
  // **拦截一切群聊请求**（fail-closed），随后才真正初始化判定表。
  let initDone = false

  async function initialize() {
    if (initDone) return
    configSettled = !db
    for (const platform of new Set(ctx.bots.map(bot => bot.platform))) {
      try {
        await ensurePlatformLoaded(platform)
      } catch (error) {
        logger.warn('载入 %s 平台白名单失败：%s', platform, error instanceof Error ? error.message : error)
      }
    }
    initDone = true
    logger.info(
      '白名单已就绪：%s，%d 个平台、%d 个群',
      db ? `数据库（表 ${TABLE}）` : `配置文件（fallbackGroups，${config.fallbackGroups.length} 项）`,
      platformLoaded.size,
      allowedGroups.size,
    )
    startNameScheduler()
  }

  ctx.on('ready', () => {
    const delay = Math.max(0, config.startupDelay ?? 3) * 1000
    if (!delay) {
      initialize()
      return
    }
    logger.debug('启动闸门已开启：%d 秒内拦截全部群聊请求，随后初始化白名单', delay / 1000)
    ctx.setTimeout(() => { initialize() }, delay)
  })
}
