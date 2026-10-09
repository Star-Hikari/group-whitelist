import { Context, Session, Schema, Service } from 'koishi'

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
  /** 是否开放群聊申请功能 */
  applyEnabled: boolean
  /** 接收申请推送的超级管理员用户 ID（单个，留空则只记录申请不推送） */
  superAdminId: string
  /** 同一人两次申请之间的最小间隔（秒） */
  applyIntervalSeconds: number
  /** 同一人每天最多提交多少次申请，0 表示不限制 */
  applyDailyLimit: number
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
        authorityCheck: Schema.const(true),
        authorityLevel: Schema.number().min(0).max(5).default(3).description('使用管理指令所需的最低 authority 等级。Koishi 默认用户等级为 1，所以默认只有手动提权过的人能用'),
      }),
      Schema.object({}),
    ]),

    // 仅在启用管理员数组时展示名单
    Schema.union([
      Schema.object({
        adminCheck: Schema.const(true),
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
  // ==================== 审批机制设置 ====================
  //
  // 注意：这里的四项**刻意不做条件折叠**。
  // 控制台的配置表单只对「已经保存进配置文件」的键求值分支条件，没保存过的键取不到值，
  // 于是挂在它下面的字段会一起不渲染 —— 曾经把限流两项挂在 `applyEnabled === true`
  // 这个分支下，用户升级后 `applyEnabled` 还没有保存值，两项直接在控制台里消失了。
  // 这几项数量少、语义独立，直接平铺展示反而更稳。
  Schema.object({
    applyEnabled: Schema.boolean().default(true).description('是否开放群聊申请。用户私聊机器人发送「申请群聊 <群号>」即可提交申请'),
    superAdminId: Schema.string().default('').description('接收申请推送的用户 ID（单个，跨平台共用；留空则只记录申请、不做推送）。注意它只决定推送对象，审批权限仍由上面的管理员设置决定'),
    applyIntervalSeconds: Schema.number().min(0).max(86400).default(60).description('同一个人两次申请之间的最小间隔（秒），0 表示不限制。申请指令不受私聊策略限制，因此用限流防刷'),
    applyDailyLimit: Schema.number().min(0).max(100).default(5).description('同一个人每天最多提交多少次申请，0 表示不限制'),
  }).description('审批机制设置'),
]) as unknown as Schema<Config>

// ==================== 数据库模型 ====================

declare module 'koishi' {
  interface Tables {
    groupWhitelist: GroupWhitelistEntry
    groupApplication: GroupApplicationEntry
  }

  interface Events {
    /** 手动刷新白名单缓存（可选传入平台名，只刷新该平台） */
    'group-whitelist/refresh'(platform?: string): void
    /**
     * onebot 适配器把戳一戳、撤回、表情回应等通知类事件派发为 notice / onebot 事件。
     * 适配器自身没有声明这些事件类型，这里补上声明，好让本插件能监听它们做拦截与日志。
     */
    'notice'(session: Session): void
    'onebot'(session: Session): void
  }

  interface Context {
    /** 由本插件提供的群白名单服务，其他插件可用它判断某个会话是否被允许 */
    groupWhitelist: GroupWhitelist
  }
}

/**
 * 群白名单服务。
 *
 * 按 Koishi 官方「自定义服务」的写法实现：继承 Service 并 `super(ctx, name, immediate)`。
 * 但**必须补一行 `ctx.set`**，原因是 cordis 的 Service 构造函数里：
 *
 * ```js
 * if (immediate) {
 *   if (_ctx) self[symbols.expose] = name      // 只是标记，交给插件解析器去注册
 *   else self.ctx.set(name, self)
 * }
 * ctx.on('ready', async () => {
 *   await self.start()
 *   if (!immediate) self.ctx.set(name, self)   // 注意条件：immediate 为真时这里不注册
 * })
 * ```
 *
 * 也就是说「传入 ctx 且 immediate = true」这条路径**不会**真正把服务写进 store
 * （`expose` 只在 `new Plugin()` 形式加载插件时被解析，本插件用的是 `apply` 形式），
 * 结果 `ctx.groupWhitelist` 一直是 undefined，只有 `provide` 声明生效。
 * 因此这里显式调用一次 `ctx.set`，保证服务在 `ready` 之前就可用。
 *
 * 服务类型必须 **导出**：它被 `declare module 'koishi'` 里的 `Context` 增强引用，
 * 若声明为模块内私有类型，tsc 会认为无法命名而在生成的 .d.ts 中**静默丢弃整个增强块**，
 * 导致其他插件（如 bot-poke）编译时报 `Property 'groupWhitelist' does not exist on type 'Context'`。
 *
 * 用法（其他插件）：
 *
 * ```ts
 * export const inject = { optional: ['groupWhitelist'] }
 * // …
 * if (!ctx.groupWhitelist?.isAllowed(session)) return
 * ```
 */
export class GroupWhitelist extends Service {
  constructor(
    ctx: Context,
    private readonly isAllowedSession: (session: Session) => boolean,
    private readonly isAllowedGroupFn: (platform: string, groupId: string) => boolean,
    private readonly refreshFn: (platform?: string) => Promise<void>,
  ) {
    super(ctx, 'groupWhitelist', true)
    // 见上方说明：immediate 路径不会自动注册，必须显式 set
    ctx.set('groupWhitelist', this)
  }

  /** 当前会话所在群是否在白名单内；私聊按 privateChat 策略判定 */
  isAllowed(session: Session): boolean {
    return this.isAllowedSession(session)
  }

  /** 直接按平台 + 群号判定 */
  isAllowedGroup(platform: string, groupId: string): boolean {
    return this.isAllowedGroupFn(platform, groupId)
  }

  /** 强制重新载入判定表 */
  refresh(platform?: string): Promise<void> {
    return this.refreshFn(platform)
  }
}

export interface GroupWhitelistEntry {
  /** 平台名，如 onebot / qq */
  platform: string
  /** 群号（guildId） */
  groupId: string
  /** 群名称，仅用于展示 */
  name: string
  /** 群人数（get_group_info 的 member_count，取不到为 0） */
  memberCount: number
  /** 备注（预留字段，当前版本始终为空，供后续扩展） */
  remark: string
  /** 机器人在该群的等级，未开启聊天等级或取不到时为 '0' */
  botLevel: string
  /** 由谁添加 */
  creator: string
  /** 添加时间 */
  createdAt: Date
}

/** 申请状态 */
export type ApplicationStatus = 'pending' | 'approved' | 'rejected'

export interface GroupApplicationEntry {
  /** 申请编号，自增主键 */
  id: number
  /** 平台名 */
  platform: string
  /** 申请加入的群号 */
  groupId: string
  /** 群名称（提交时抓取，取不到为空） */
  name: string
  /** 群人数（提交时的快照，审批通过时会更新为最新值） */
  memberCount: number
  /** 申请人用户 ID */
  applicant: string
  /** 申请人昵称 */
  applicantName: string
  /** 申请状态 */
  status: ApplicationStatus
  /** 处理人用户 ID，未处理为空 */
  reviewer: string
  /** 预留字段：申请理由（当前版本不采集，始终为空） */
  reason: string
  /** 提交时间 */
  createdAt: Date
  /** 处理时间，未处理为 null */
  reviewedAt: Date | null
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
  const APPLY_TABLE = 'groupApplication' as const

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

  // ---------- 群详细信息获取 ----------
  //
  // 适配器的 adaptGuild() 只保留 { id, name }，其余字段全被丢掉：
  //   const adaptGuild = (info) => ({ id: group.group_id.toString(), name: group.group_name })
  // 因此想拿人数、简介这些必须绕开适配器，直接调用协议端接口。
  // Internal._get(action, params) 是通用的（内部只在 _request 之上做 retcode 校验），
  // 所以任何协议端接口都能这样调用，不需要适配器提前声明。
  interface OneBotInternal {
    _get(action: string, params?: Record<string, unknown>): Promise<any>
  }

  function getInternal(platform: string, selfId?: string): OneBotInternal | null {
    const bot = pickBot(platform, selfId)
    const internal = (bot as any)?.internal as OneBotInternal | undefined
    return typeof internal?._get === 'function' ? internal : null
  }

  /** 从各种可能的字段名里取一个非空数值 */
  function pickNumber(source: any, keys: string[]): number {
    for (const key of keys) {
      const value = source?.[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
    }
    return 0
  }

  /**
   * 查询群的人数。
   *
   * 只走标准的 `get_group_info`（`member_count` 是 OneBot 标准字段，可靠）。
   * 群简介与建群时间需要 NapCat 的扩展接口 `get_group_info_ex`，实测本环境拿不到，
   * 已整体移除，避免每次刷新都白打一轮接口。群卡片（`ArkShareGroup`）同理已移除。
   *
   * 失败只记 debug 日志并返回 0，绝不影响白名单主流程。
   */
  async function fetchMemberCount(platform: string, groupId: string, selfId?: string): Promise<number> {
    const internal = getInternal(platform, selfId)
    if (!internal) return 0
    try {
      const data = await internal._get('get_group_info', { group_id: Number(groupId), no_cache: true })
      return pickNumber(data, ['member_count', 'memberCount', 'member_num'])
    } catch (error) {
      logger.debug('获取群 %s/%s 的人数失败：%s', platform, groupId, error instanceof Error ? error.message : error)
      return 0
    }
  }

  /**
   * 查询机器人在该群的等级。
   * 注意：只有机器人**已经在群里**才能查到，未加入的群会报错，因此申请阶段拿不到等级，
   * 要等审批通过入群之后，由定期刷新来补齐。群未开启聊天等级时 NapCat 一般返回 "0"。
   */
  async function fetchBotLevel(platform: string, groupId: string, selfId?: string): Promise<string> {
    const internal = getInternal(platform, selfId)
    if (!internal) return ''
    const bot = pickBot(platform, selfId)
    try {
      const data = await internal._get('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(bot?.selfId ?? selfId ?? 0),
        no_cache: true,
      })
      const level = data?.level
      if (level === undefined || level === null) return ''
      return String(level)
    } catch (error) {
      logger.debug('获取群 %s/%s 的机器人等级失败：%s', platform, groupId, error instanceof Error ? error.message : error)
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
   * 刷新白名单群的展示信息：群名 + 人数 + 机器人等级。
   * 等级必须机器人已在群内才查得到，因此新通过审批的群要等下一次刷新才会补上。
   * @param targets 指定要刷新的群；不传则刷新全部已入库的群
   * @returns 统计信息，便于指令回报与日志
   */
  async function refreshGroupNames(targets?: { platform: string, groupId: string }[]) {
    const database = db
    if (!database) {
      return { total: 0, updated: 0, failed: 0, skipped: true }
    }

    let rows: { platform: string, groupId: string, name: string, memberCount: number, botLevel: string }[]
    const fields = ['platform', 'groupId', 'name', 'memberCount', 'botLevel'] as const
    if (targets?.length) {
      rows = []
      for (const target of targets) {
        try {
          const found = await database.get(TABLE, target, fields as never)
          if (found[0]) rows.push(found[0] as never)
        } catch (error) {
          logger.warn('读取群 %s/%s 失败：%s', target.platform, target.groupId, error instanceof Error ? error.message : error)
        }
      }
    } else {
      try {
        rows = await database.get(TABLE, {}, fields as never) as never
      } catch (error) {
        logger.warn('读取白名单失败：%s', error instanceof Error ? error.message : error)
        return { total: 0, updated: 0, failed: 0, skipped: false }
      }
    }

    if (!rows.length) return { total: 0, updated: 0, failed: 0, skipped: false }

    const size = Math.max(1, Math.min(20, config.groupNameBatch ?? 5))
    const fetched = await inBatches(rows, size, async (row) => {
      // 各项彼此独立、就地 catch，避免一项失败把另两项已经拿到的数据一起丢掉
      const [name, memberCount, botLevel] = await Promise.all([
        fetchGroupName(row.platform, row.groupId).catch(() => ''),
        fetchMemberCount(row.platform, row.groupId).catch(() => 0),
        fetchBotLevel(row.platform, row.groupId).catch(() => ''),
      ])
      return { name, memberCount, botLevel }
    })

    let updated = 0
    let failed = 0
    for (let index = 0; index < rows.length; ++index) {
      const row = rows[index]
      const info = fetched[index]

      // 只要有一项取到了就写回；取不到的项保留原值，避免把已有数据清空
      const patch: Record<string, unknown> = {}
      if (info.name && info.name !== row.name) patch.name = info.name
      if (info.memberCount > 0 && info.memberCount !== row.memberCount) patch.memberCount = info.memberCount
      if (info.botLevel && info.botLevel !== row.botLevel) patch.botLevel = info.botLevel

      if (!info.name) failed++
      if (!Object.keys(patch).length) continue
      try {
        await database.set(TABLE, { platform: row.platform, groupId: row.groupId }, patch as never)
        updated++
      } catch (error) {
        logger.warn('更新群 %s/%s 的信息失败：%s', row.platform, row.groupId, error instanceof Error ? error.message : error)
        failed++
      }
    }

    logger.info('群信息刷新完成：共 %d 个群，更新 %d 个，名称取不到 %d 个', rows.length, updated, failed)
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
      // 群信息的来源优先级：当前会话事件里带的群名（若平台提供）→ 调用协议端接口查询。
      // OneBot 的群消息事件不带群名，所以绝大多数情况下走的是接口查询这条路径。
      const batch = Math.max(1, Math.min(20, config.groupNameBatch ?? 5))
      const infos = await inBatches(pending, batch, async (groupId) => {
        // 各项就地 catch，避免一项失败拖垮整组
        const [name, memberCount, botLevel] = await Promise.all([
          (async () => getEventGuildName(session, groupId) || await fetchGroupName(platform, groupId, session.selfId))().catch(() => ''),
          fetchMemberCount(platform, groupId, session.selfId).catch(() => 0),
          fetchBotLevel(platform, groupId, session.selfId).catch(() => ''),
        ])
        return { name, memberCount, botLevel }
      })

      // 注意：minato 的 database.create() 只接受单条记录，传数组会被判为「缺少主键」，
      // 因此这里逐条插入；数量可控（指令批量输入），不必为此改用 upsert。
      for (let index = 0; index < pending.length; ++index) {
        const groupId = pending[index]
        const info = infos[index]
        try {
          await database.create(TABLE, {
            platform,
            groupId,
            name: info?.name ?? '',
            memberCount: info?.memberCount ?? 0,
            // 备注是预留字段，当前版本始终留空
            remark: '',
            botLevel: info?.botLevel ?? '',
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

  // ---------- 审批机制 ----------

  /** 取申请人的昵称（事件里带的昵称优先，兜底用数据库用户表） */
  async function resolveUserName(session: Session): Promise<string> {
    const fromEvent = session.event?.user?.name
    if (fromEvent) return fromEvent
    try {
      const user = await session.observeUser(['name'])
      return (user as any)?.name ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 申请限流。
   * 「申请群聊」指令刻意不受 privateChat 策略限制（否则被挡的用户根本没法申诉），
   * 所以用内存限流防刷：24 小时滑动窗口计数 + 两次之间的最小间隔。
   * 记录只存内存，重启后清零 —— 对防刷来说足够，也避免了再写一张表。
   */
  function checkApplyQuota(userId: string): { ok: boolean, reason?: 'interval' | 'daily', waitSeconds?: number } {
    const now = Date.now()
    const windowStart = now - 24 * 60 * 60 * 1000
    const history = (applyHistory.get(userId) ?? []).filter(time => time > windowStart)

    const interval = config.applyIntervalSeconds ?? 60
    if (interval > 0 && history.length) {
      const last = history[history.length - 1]
      const elapsed = (now - last) / 1000
      if (elapsed < interval) {
        applyHistory.set(userId, history)
        return { ok: false, reason: 'interval', waitSeconds: Math.ceil(interval - elapsed) }
      }
    }

    const limit = config.applyDailyLimit ?? 0
    if (limit > 0 && history.length >= limit) {
      applyHistory.set(userId, history)
      return { ok: false, reason: 'daily' }
    }

    history.push(now)
    applyHistory.set(userId, history)
    return { ok: true }
  }

  /** 组装推送文本：能取到的信息才显示，取不到的整行跳过 */
  function buildApplyMessage(entry: GroupApplicationEntry) {
    const lines = [`📋 新的群聊申请 #${entry.id}`]
    lines.push(`申请人：${entry.applicantName || '未知'}（${entry.applicant}）`)
    lines.push(`群号：${entry.groupId}${entry.name ? `（${entry.name}）` : ''}`)
    lines.push(`平台：${entry.platform}`)
    if (entry.memberCount > 0) lines.push(`人数：${entry.memberCount}`)
    lines.push(`时间：${formatTime(entry.createdAt)}`)
    lines.push('')
    lines.push(`同意：白名单.同意 ${entry.id}`)
    lines.push(`拒绝：白名单.拒绝 ${entry.id}`)
    lines.push('查看全部：白名单.审批列表')
    return lines.join('\n')
  }

  /**
   * 把申请推送给超级管理员。
   * 只发纯文本 —— 群卡片（ArkShareGroup）实测在本环境拿不到，已整体移除。
   */
  async function pushApplication(entry: GroupApplicationEntry) {
    const adminId = config.superAdminId?.trim()
    if (!adminId) {
      logger.info('申请 #%d 已记录，但未配置接收推送的超级管理员（superAdminId），本条不做推送', entry.id)
      return
    }

    const bot = pickBot(entry.platform)
    if (!bot) {
      logger.warn('申请 #%d 无法推送：找不到 %s 平台的机器人', entry.id, entry.platform)
      return
    }

    let target: Session
    try {
      target = bot.session({ type: 'private', channel: { id: `private:${adminId}`, type: 1 } as never, user: { id: adminId } as never })
    } catch (error) {
      logger.warn('申请 #%d 构造私聊会话失败：%s', entry.id, error instanceof Error ? error.message : error)
      return
    }

    try {
      await target.send(buildApplyMessage(entry))
    } catch (error) {
      // 推送失败不影响申请本身，管理员可以随时用「白名单.审批列表」查看
      logger.warn('推送申请 #%d 给超级管理员失败：%s', entry.id, error instanceof Error ? error.message : error)
    }
  }

  type AuditResult =
    | { ok: true, entry: GroupApplicationEntry }
    | { ok: false, reason: 'notfound' | 'handled' | 'dbmissing' | 'error', entry?: GroupApplicationEntry, message?: string }

  /** 渲染审批失败的原因；抽出来是为了让两个指令共用同一套文案 */
  function describeAuditFailure(result: AuditResult, id: number, selfId: string): string {
    if (result.ok !== false) return ''
    if (result.reason === 'dbmissing') return '当前未注册数据库，无法处理申请。'
    if (result.reason === 'notfound') return `没有找到编号为 #${id} 的申请。`
    if (result.reason === 'handled') {
      const who = result.entry?.reviewer || '其他人'
      const label = result.entry?.status === 'approved' ? '已同意' : '已拒绝'
      return `申请 #${id} 已经被${who === selfId ? '你' : who}处理过（${label}）。`
    }
    return `处理申请失败：${result.message ?? '未知错误'}`
  }

  /**
   * 处理一条申请。
   * 并发安全的关键：先用「status = pending」作为条件做条件更新，只有真正改动了行的那一次
   * 才算抢到，因此两个管理员同时点同一条不会重复加白。
   */
  async function auditApplication(id: number, approve: boolean, reviewer: string): Promise<AuditResult> {
    const database = db
    if (!database) return { ok: false, reason: 'dbmissing' }

    let entry: GroupApplicationEntry | undefined
    try {
      const found = await database.get(APPLY_TABLE, { id })
      entry = found[0]
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    if (!entry) return { ok: false, reason: 'notfound' }
    if (entry.status !== 'pending') return { ok: false, reason: 'handled', entry }

    const status: ApplicationStatus = approve ? 'approved' : 'rejected'

    // 条件写入：minato 的 set(query, update) 会把 query 里除主键外的字段一并作为 WHERE 条件，
    // 因此「只有仍是 pending 的行会被改动」，不会覆盖别人的结论。
    // minato **没有**返回改动行数的 update()（实测 database.update is not a function），
    // 所以这里靠三层保障：
    //   1. 上面的预检查挡掉绝大多数并发；
    //   2. 条件 set 保证不会把已处理的申请再改一次；
    //   3. 写回后就近复查 reviewedAt 是否「刚刚」—— 不做精确时间戳比较，
    //      因为时间字段可能被数据库截断精度。
    const reviewedAt = new Date()
    const claimWindowMs = 10_000
    try {
      await database.set(APPLY_TABLE, { id, status: 'pending' } as never, { status, reviewer, reviewedAt } as never)
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }

    let after: GroupApplicationEntry | undefined
    try {
      const found = await database.get(APPLY_TABLE, { id })
      after = found[0]
    } catch { /* 复查失败时沿用认领前读到的记录 */ }
    if (after) {
      const mine = after.status === status
        && after.reviewer === reviewer
        && !!after.reviewedAt
        && Math.abs(Date.now() - after.reviewedAt.getTime()) < claimWindowMs
      if (!mine) return { ok: false, reason: 'handled', entry: after }
    }

    if (approve) {
      // 同意：写入白名单（已存在则跳过写入，但申请照样标记为已通过）
      const target = (after ?? entry)
      const now = Date.now()
      try {
        const exist = await database.get(TABLE, { platform: target.platform, groupId: target.groupId }, ['groupId'])
        if (!exist.length) {
          // 顺便取最新的人数与机器人等级（此时机器人可能已经进群了）
          const [memberCount, botLevel] = await Promise.all([
            fetchMemberCount(target.platform, target.groupId).catch(() => 0),
            fetchBotLevel(target.platform, target.groupId).catch(() => ''),
          ])
          await database.create(TABLE, {
            platform: target.platform,
            groupId: target.groupId,
            name: target.name || '',
            memberCount: memberCount || target.memberCount || 0,
            // 备注是预留字段，当前版本始终留空
            remark: '',
            botLevel: botLevel || '',
            // creator 记录最初的申请人，便于追溯这个群是谁申请进来的
            creator: target.applicant,
            createdAt: new Date(),
          } as never)
          markAllowed(target.platform, target.groupId)

          // 申请表里的人数快照同步更新为最新值
          if (memberCount > 0) {
            await database.set(APPLY_TABLE, { id }, { memberCount } as never).catch(() => {})
          }
          logger.info('申请 #%d 已通过，群 %s/%s 已加入白名单（耗时 %d ms）', id, target.platform, target.groupId, Date.now() - now)
        } else {
          markAllowed(target.platform, target.groupId)
          logger.info('申请 #%d 已通过，群 %s/%s 原本就在白名单中', id, target.platform, target.groupId)
        }
      } catch (error) {
        logger.warn('申请 #%d 写入白名单失败：%s', id, error instanceof Error ? error.message : error)
        return { ok: false, reason: 'error', entry: after ?? entry, message: error instanceof Error ? error.message : String(error) }
      }
    } else {
      logger.info('申请 #%d 已被 %s 拒绝', id, reviewer)
    }

    return { ok: true, entry: after ?? entry }
  }

  /** 把审批结果私聊通知申请人；发送失败只记日志，不影响审批结果 */
  async function notifyApplicant(entry: GroupApplicationEntry, approve: boolean) {
    const bot = pickBot(entry.platform)
    if (!bot) return
    const groupLabel = `${entry.groupId}${entry.name ? `（${entry.name}）` : ''}`
    const text = approve
      ? `你申请的群 ${groupLabel} 已通过审批，已加入白名单，现在可以在群里正常使用机器人了。`
      : `你申请的群 ${groupLabel} 未通过审批。如有疑问请联系管理员。`
    try {
      const target = bot.session({
        type: 'private',
        channel: { id: `private:${entry.applicant}`, type: 1 } as never,
        user: { id: entry.applicant } as never,
      })
      await target.send(text)
    } catch (error) {
      logger.debug('通知申请人 %s 失败（可能未加好友），不影响审批结果：%s', entry.applicant, error instanceof Error ? error.message : error)
    }
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
  /**
   * 白名单判定表是否已初始化完成（启动闸门的开关）。
   *
   * 必须声明在使用它的函数**之前**：`ctx.inject` 的回调是同步执行的，
   * 若把 `let initDone` 放在文件靠后，`resetDecisions()` 会踩到暂时性死区
   * （ReferenceError: Cannot access 'initDone' before initialization）。
   */
  let initDone = false

  // ---------- 审批机制状态 ----------
  /** 申请限流记录：userId -> 该用户最近若干次申请的时间戳（毫秒） */
  const applyHistory = new Map<string, number[]>()

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
  /**
   * 总闸覆盖的事件类型。
   *
   * 关键点：**不能只拦消息事件**。OneBot 的戳一戳、撤回、表情回应等都以 notice/onebot
   * 事件的形式抵达，它们同样可能触发插件发言（例如 bot-poke 收到戳戳就回一句），
   * 如果只拦 message，这些插件就会在白名单之外的群里继续响应。
   *
   * 只列出「用户可感知、插件会据此发言」的事件；入群、好友请求等管理类事件不在此列，
   * 否则入群提示、加好友审核这类功能会被误伤。
   *
   * 注意 `message-created`：Satori 的 `Bot.dispatch` 会按 eventAliases 把 message 规范化成
   * `message-created`，因此事件对象上的 type 只有这个规范名，必须一起列出。
   */
  const GATED_EVENTS = new Set(['message', 'message-created', 'notice', 'onebot'])

  ctx.before('attach', (session) => {
    if (!session.userId || !session.event) return
    if (!session.guildId) return
    if (!GATED_EVENTS.has(session.event.type)) return
    ensurePlatformLoaded(session.platform).catch((error) => {
      logger.warn('载入白名单失败：%s', error instanceof Error ? error.message : error)
    })
  })

  ctx.on('message', (session) => {
    if (!session.userId || !session.event) return
    if (!GATED_EVENTS.has(session.event.type)) return
    const blocked = resolveBlockSync(session)
    if (blocked === null) return
    blockedMap.set(session, blocked)
    session.response = async () => blockedMap.get(session) ?? ''
  }, { prepend: true })

  // notice / onebot 事件不经过消息流水线，插件是在自己的事件监听器里直接发言的，
  // 没有统一的「拦截点」可以借用。因此这里在事件链最前面做一次判定：
  // 未命中白名单时只记日志（保持静默语义），真正的「让插件闭嘴」由
  // whitelist 服务提供的 isAllowed() 由各插件自行查询完成，见下方 provide。
  ctx.on('notice', (session) => logBlockedEvent(session), { prepend: true })
  ctx.on('onebot', (session) => logBlockedEvent(session), { prepend: true })

  function logBlockedEvent(session: Session) {
    if (!session.userId || !session.event) return
    if (!session.guildId) return
    if (resolveBlockSync(session) === null) return
    if (config.enableLog) {
      logger.debug('已拦截非白名单群的非消息事件：%s / %s / %s', session.platform, session.guildId, session.event.type)
    }
  }

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
      '  白名单.刷新      立刻重新拉取群名称/人数/简介/等级（别名 白名单.refresh / 白名单.同步群名）',
      '  白名单.审批列表  查看待审批的群聊申请（别名 白名单.申请列表 / 白名单.待审批）',
      '  白名单.同意      通过一条申请，如 白名单.同意 12（别名 白名单.批准 / 白名单.通过）',
      '  白名单.拒绝      驳回一条申请，如 白名单.拒绝 12（别名 白名单.驳回）',
      '',
      '用户侧指令（私聊，无需权限）：',
      '  申请群聊 <群号>  提交把群加入白名单的申请，例如 申请群聊 123456',
      '  申请状态         查看自己提交过的申请与处理进度',
      '',
      '指令选项：',
      '  -p, --platform <name>  指定平台（默认取当前会话所在平台）',
      '  -a, --all              审批列表：连同已处理的申请一起列出',
      '',
      '示例：',
      '  白名单.列表',
      '  白名单.添加 123456 654321',
      '  白名单.添加 -p qq 123456,654321',
      '  白名单.移除 123456',
      '  白名单.刷新',
      '  白名单.审批列表 -a',
      '  白名单.同意 12',
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

  const approve = command.subcommand('.同意 <id:number>', '通过一条群聊申请', base)
    .alias('.批准', '.通过', '.approve', '.accept')
    .example('白名单.同意 12')

  const reject = command.subcommand('.拒绝 <id:number>', '驳回一条群聊申请', base)
    .alias('.驳回', '.reject', '.deny')
    .example('白名单.拒绝 12')

  const auditList = command.subcommand('.审批列表', '查看待审批的群聊申请', base)
    .alias('.申请列表', '.待审批', '.review', '.applications')
    .option('all', '-a 连同已处理的申请一起列出', { type: 'boolean' as const, authority: 0 })
    .example('白名单.审批列表')
    .example('白名单.审批列表 -a')

  // 申请类指令刻意**不挂**在 whitelist 之下，也不受私聊策略限制：
  // 白名单外的用户必须能申诉，否则这个机制就没有出口。
  const apply = ctx.command('apply-group <digits:string>', '申请把群聊加入白名单', { authority: 0, showWarning: false })
    .alias('申请群聊', '申请白名单', '申请加入白名单')
    .example('申请群聊 123456')

  const applyStatus = ctx.command('apply-status', '查看自己的群聊申请进度', { authority: 0, showWarning: false })
    .alias('申请状态', '我的申请')
    .example('申请状态')

  const commands = [command, list, add, remove, refreshNames, approve, reject, auditList]
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
        rows.push({
          platform,
          groupId: parsed.groupId,
          name: '',
          // 配置模式没有可持久化的位置，这些展示字段一律留空
          memberCount: 0,
          remark: '',
          botLevel: '',
          creator: '',
          createdAt: new Date(0),
        })
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
        const people = row.memberCount > 0 ? `｜${row.memberCount} 人` : ''
        const level = row.botLevel && row.botLevel !== '0' ? `｜等级 ${row.botLevel}` : ''
        const remark = row.remark ? `｜备注 ${row.remark.length > 30 ? row.remark.slice(0, 30) + '…' : row.remark}` : ''
        lines.push(`${isSelf ? '▶' : '·'} ${row.groupId}${row.name ? `（${row.name}）` : ''}${people}${level}${remark}${since}`)
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

    await session.send('正在拉取群信息，请稍候…')
    const result = await refreshGroupNames(targets)

    const scope = platform ? `${platform} 平台` : '全部平台'
    const lines = [`群信息刷新完成（${scope}）：共 ${result.total} 个群。`]
    if (result.updated) lines.push(`已更新 ${result.updated} 个群的名称/人数/简介/等级。`)
    if (result.failed) lines.push(`${result.failed} 个群未能取到名称，已保留原值（多为平台不支持或接口异常）。`)
    if (!result.updated && !result.failed) lines.push('所有群信息都是最新的，无需更新。')
    return lines.join('\n')
  })

  // ---------- 提交申请 ----------
  apply.action(async ({ session, args }) => {
    if (!session) return
    // 申请只走私聊：群聊里提交会把群号暴露给无关的人，也容易刷屏
    if (!session.isDirect) {
      return '请私聊机器人发送「申请群聊 <群号>」来提交申请。'
    }
    if (!config.applyEnabled) {
      return '群聊申请功能当前未开放。'
    }
    if (!db) {
      return '当前未注册数据库，申请无法保存，请先安装数据库插件（如 database-sqlite）。'
    }
    if (!session.userId) {
      return '无法识别你的用户 ID，申请失败。'
    }

    const { valid, invalid } = parseGroupIds([String(args[0] ?? '')])
    if (!valid.length) {
      return invalid.length
        ? `群号格式不正确：${invalid.join('、')}。群号应为纯数字，例如：申请群聊 123456`
        : '请提供要申请的群号，例如：申请群聊 123456'
    }
    const groupId = valid[0]
    const platform = resolvePlatform(session)
    if (!platform) {
      return '无法确定平台，请在只有单个平台在线时再试。'
    }

    const quota = checkApplyQuota(session.userId)
    if (!quota.ok) {
      if (quota.reason === 'interval') {
        return `申请太频繁了，请 ${quota.waitSeconds} 秒后再试。`
      }
      return `你今天提交的申请已达上限（${config.applyDailyLimit} 次），请明天再试。`
    }

    // 已经在白名单里的群不必申请
    if (isGroupAllowedSync(platform, groupId)) {
      return `群 ${groupId} 已经在白名单中，无需申请。`
    }

    let duplicated = false
    try {
      const pending = await db.get(APPLY_TABLE, { platform, groupId, status: 'pending' }, ['id'])
      duplicated = pending.length > 0
    } catch (error) {
      logger.warn('查询待审批申请失败：%s', error instanceof Error ? error.message : error)
    }
    if (duplicated) {
      return `该群已经有一条待审批的申请了，请耐心等待管理员处理（可用「申请状态」查看进度）。`
    }

    // 抓群名与人数：get_group_info 对未加入的群同样有效，所以申请阶段就能拿到
    const [name, memberCount] = await Promise.all([
      fetchGroupName(platform, groupId, session.selfId).catch(() => ''),
      fetchMemberCount(platform, groupId, session.selfId).catch(() => 0),
    ])
    const applicantName = await resolveUserName(session)

    let created: GroupApplicationEntry | undefined
    const now = new Date()
    try {
      await db.create(APPLY_TABLE, {
        platform,
        groupId,
        name,
        memberCount,
        applicant: session.userId,
        applicantName,
        status: 'pending',
        reviewer: '',
        reason: '',
        createdAt: now,
        reviewedAt: null,
      } as never)

      // 不要把 create() 的返回值当主键用：不同 minato 版本返回的可能不是自增 id。
      // 直接按「平台 + 群号 + 申请人 + 待审批」回查最新一条，稳定且不受返回值影响。
      const rows = await db.get(APPLY_TABLE, {
        platform, groupId, applicant: session.userId, status: 'pending',
      }, { sort: { id: 'desc' }, limit: 1 })
      created = rows[0]
    } catch (error) {
      logger.warn('写入申请失败：%s', error instanceof Error ? error.message : error)
      return '提交申请失败，请查看控制台日志。'
    }

    if (!created?.id) {
      // 极少数情况下回查失败：申请已经写入，只是拿不到编号，此时不该谎报失败
      logger.warn('申请已写入但未能回查编号：%s/%s（申请人 %s）', platform, groupId, session.userId)
      return '申请已提交，但读取编号失败，请联系管理员用「白名单.审批列表」查看。'
    }

    logger.info('收到群聊申请 #%d：%s/%s（申请人 %s）', created.id, platform, groupId, session.userId)

    // 推送失败不影响申请本身，管理员随时可以用「白名单.审批列表」查看
    await pushApplication(created).catch((error) => {
      logger.warn('推送申请 #%d 失败：%s', created!.id, error instanceof Error ? error.message : error)
    })

    return `申请已提交，编号 #${created.id}。管理员处理后我会私聊通知你，也可以发送「申请状态」查看进度。`
  })

  // ---------- 查询自己的申请 ----------
  applyStatus.action(async ({ session }) => {
    if (!session) return
    if (!session.isDirect) {
      return '请私聊机器人发送「申请状态」查看申请进度。'
    }
    if (!db) return '当前未注册数据库，没有可查询的申请记录。'
    if (!session.userId) return '无法识别你的用户 ID。'

    let rows: GroupApplicationEntry[] = []
    try {
      rows = await db.get(APPLY_TABLE, { applicant: session.userId }, {
        sort: { createdAt: 'desc' },
        limit: 20,
      })
    } catch (error) {
      logger.warn('查询申请失败：%s', error instanceof Error ? error.message : error)
      return '查询申请失败，请查看控制台日志。'
    }

    if (!rows.length) return '你还没有提交过群聊申请。发送「申请群聊 <群号>」即可提交。'

    const labels: Record<ApplicationStatus, string> = {
      pending: '待审批',
      approved: '已同意',
      rejected: '已拒绝',
    }
    const lines = [`你的群聊申请（共 ${rows.length} 条）`]
    for (const row of rows) {
      const name = row.name ? `（${row.name}）` : ''
      const when = row.status === 'pending' ? formatTime(row.createdAt) : formatTime(row.reviewedAt ?? row.createdAt)
      lines.push(`#${row.id} ${row.groupId}${name} — ${labels[row.status] ?? row.status}（${when}）`)
    }
    return lines.join('\n')
  })

  // ---------- 审批：同意 ----------
  approve.action(async ({ session, args }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return
    const id = Number(args[0])
    if (!Number.isInteger(id) || id <= 0) return '请提供有效的申请编号，例如：白名单.同意 12'

    const result = await auditApplication(id, true, session.userId)
    if (result.ok !== true) return describeAuditFailure(result, id, session.userId)

    // 通知申请人是「尽力而为」：失败只记日志，不影响审批结果
    await notifyApplicant(result.entry, true)
    return `已通过申请 #${result.entry.id}，群 ${result.entry.groupId} 已加入白名单。`
  })

  // ---------- 审批：拒绝 ----------
  reject.action(async ({ session, args }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return
    const id = Number(args[0])
    if (!Number.isInteger(id) || id <= 0) return '请提供有效的申请编号，例如：白名单.拒绝 12'

    const result = await auditApplication(id, false, session.userId)
    if (result.ok !== true) return describeAuditFailure(result, id, session.userId)

    await notifyApplicant(result.entry, false)
    return `已驳回申请 #${result.entry.id}（群 ${result.entry.groupId}）。申请人可以重新提交申请。`
  })

  // ---------- 审批列表 ----------
  auditList.action(async ({ session, options }) => {
    if (!session) return
    if (!await ensureAdmin(session)) return
    if (!db) return '当前未注册数据库，没有可查看的申请记录。'

    const query = options.all ? {} : { status: 'pending' }
    let rows: GroupApplicationEntry[] = []
    try {
      rows = await db.get(APPLY_TABLE, query as never, {
        sort: { createdAt: 'desc' },
        limit: 51,
      })
    } catch (error) {
      logger.warn('查询申请失败：%s', error instanceof Error ? error.message : error)
      return '查询申请列表失败，请查看控制台日志。'
    }

    if (!rows.length) {
      return options.all ? '目前没有任何申请记录。' : '当前没有待审批的申请。'
    }

    const labels: Record<ApplicationStatus, string> = {
      pending: '待审批',
      approved: '已同意',
      rejected: '已拒绝',
    }
    const title = options.all ? '全部群聊申请' : '待审批的群聊申请'
    const lines = [`${title}（共 ${rows.length} 条${rows.length > 50 ? '，仅显示最近 50 条' : ''}）`]
    for (const row of rows.slice(0, 50)) {
      const name = row.name ? `（${row.name}）` : ''
      const people = row.memberCount > 0 ? `｜${row.memberCount} 人` : ''
      const who = row.reviewer ? `｜处理人 ${row.reviewer}` : ''
      lines.push(`#${row.id} ${row.groupId}${name} — ${labels[row.status] ?? row.status}${people}｜${row.applicantName || row.applicant}｜${formatTime(row.createdAt)}${who}`)
    }
    if (!options.all && rows.length) {
      lines.push('')
      lines.push('同意：白名单.同意 <编号>；拒绝：白名单.拒绝 <编号>')
      lines.push('加 -a 可查看包含已处理在内的全部记录。')
    }
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
      // 人数是 OneBot 标准字段（member_count），可靠
      memberCount: { type: 'unsigned', initial: 0 },
      // 备注是预留字段，当前版本不写入任何内容；旧版本的 groupIntro（群简介）已废弃
      remark: { type: 'string', initial: '' },
      // 机器人在该群的等级，未开启聊天等级或机器人尚未入群时为 '0'
      botLevel: { type: 'string', initial: '0' },
      creator: { type: 'string', initial: '' },
      // 注意：minato 的 initial 只接受字面值、不接受工厂函数，时间戳在插入时显式赋值
      createdAt: 'timestamp',
    }, {
      primary: ['platform', 'groupId'],
      indexes: ['platform'],
    })

    // 群聊申请表：审批通过后才会写进白名单表
    ctx.model.extend('groupApplication', {
      id: 'unsigned',
      platform: 'string',
      groupId: 'string',
      name: { type: 'string', initial: '' },
      // 提交时的人数快照；审批通过时会更新为最新值
      memberCount: { type: 'unsigned', initial: 0 },
      applicant: { type: 'string', initial: '' },
      applicantName: { type: 'string', initial: '' },
      status: { type: 'string', initial: 'pending' },
      reviewer: { type: 'string', initial: '' },
      // 预留：申请理由，当前版本不采集
      reason: { type: 'string', initial: '' },
      createdAt: 'timestamp',
      reviewedAt: { type: 'timestamp', initial: null },
    }, {
      primary: 'id',
      autoInc: true,
      indexes: ['status', 'groupId'],
    })

    resetDecisions()
    logger.info('白名单存储：数据库（表 %s / %s）', TABLE, APPLY_TABLE)
    ctx.on('dispose', () => {
      db = null
      resetDecisions()
      logger.info('数据库服务已卸载，白名单回落到配置模式（fallbackGroups）')
    })
  })

  // ---------- 对外服务 ----------
  //
  // 消息事件的拦截由总闸自动完成，但其他插件在自己的 notice / onebot 监听器里直接发言
  // （例如 bot-poke 收到戳一戳就回话）时没有统一的拦截点，必须由插件主动查询。
  // 因此把白名单判定暴露成服务（见文件顶部的 GroupWhitelist 类）：
  //
  //   export const inject = { optional: ['groupWhitelist'] }
  //   ctx.on('notice', (session) => {
  //     if (!ctx.groupWhitelist?.isAllowed(session)) return   // ← 白名单外的群直接不响应
  //     ...
  //   })
  //
  // 未加载本插件时 ctx.groupWhitelist 不存在，插件按 `!ctx.groupWhitelist?.isAllowed(session)`
  // 的写法可自然退化为「不受限制」。
  //
  // 这里的构造函数第三个参数 immediate = true，表示服务**立即注册**，
  // 这样其他插件的 `inject` 不会一直等待到 ready。
  new GroupWhitelist(
    ctx,
    (session) => {
      if (!session.guildId) {
        if (config.privateChat === 'all') return true
        if (config.privateChat === 'whitelist') {
          return !!session.userId && config.privateWhitelist.includes(session.userId)
        }
        return false
      }
      return isGroupAllowedSync(session.platform, session.guildId)
    },
    isGroupAllowedSync,
    platform => refresh(platform),
  )

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
