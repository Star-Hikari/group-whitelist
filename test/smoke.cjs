// 临时冒烟测试：用真实 Context + sqlite 数据库验证拦截与指令逻辑
const { Context, Bot, h } = require('koishi')
const plugin = require('../lib/index.js')

/** sqlite 插件同时提供 ESM 与 CJS 产物，统一走动态导入取命名空间 */
async function loadSqlite() {
  const mod = await import('@koishijs/plugin-database-sqlite')
  return mod.default?.default ?? mod.default ?? mod
}

const baseConfig = {
  ignoreMessage: '',
  // 测试里不等启动闸门，直接初始化；闸门行为由场景 7 单独验证
  startupDelay: 0,
  enableLog: false,
  authorityCheck: true,
  authorityLevel: 3,
  adminCheck: true,
  adminList: [],
  fallbackGroups: [],
  privateChat: 'all',
  privateWhitelist: [],
  joinNoticeEnabled: true,
  joinNoticeText: '本群尚未启用机器人服务。',
  groupNameRefreshDays: 0,
  groupNameBatch: 5,
}

/** 注册一个 bot 用于派发合成事件；selfId 是 user.id 的访问器，需显式赋值 */
function addBot(app, platform, selfId) {
  const bot = new Bot(app, { platform, selfId }, platform)
  bot.selfId = selfId
  bot.status = 1 // ONLINE
  bot.outbox = []
  bot.sendMessage = async (channelId, content) => {
    bot.outbox.push(content)
    return []
  }
  // 模拟 OneBot 的 get_group_info：群名只能通过接口拿到，事件里没有
  bot.guildNames = {}
  bot.guildCalls = []
  bot.getGuild = async (guildId) => {
    bot.guildCalls.push(guildId)
    if (bot.guildNames[guildId] === undefined) throw new Error('group not found: ' + guildId)
    return { id: guildId, name: bot.guildNames[guildId] }
  }
  return bot
}

async function createApp(config) {
  const sqlite = await loadSqlite()
  const app = new Context({})
  app.plugin(sqlite, { path: ':memory:' })
  await app.start()
  const bot = addBot(app, 'onebot', '10000')
  // 合成事件没有真实的频道资料，需预置 channel 记录并把 assignee 指给 bot，
  // 否则 Koishi 的 attach 中间件会因缺主键抛错或直接忽略该频道
  for (const id of ['10', '100', '200', '300', '400', '500', '888', '999']) {
    await app.database.create('channel', {
      platform: 'onebot', id, guildId: id, assignee: '10000', createdAt: new Date(),
    })
  }
  // 私聊频道：Koishi 的私聊频道 id 形如 private:userId
  await app.database.create('channel', {
    platform: 'onebot', id: 'private:1', assignee: '10000', createdAt: new Date(),
  })
  // 预置用户记录与绑定关系（Koishi 通过 binding 表把「平台:用户」映射到 user.id），
  // 否则 observeUser() 会走 autoAuthorize 兜底路径，拿不到我们设定的 authority
  await app.database.create('user', { id: 1, authority: 3, locales: [], permissions: [], createdAt: new Date() })
  await app.database.create('binding', { aid: 1, bid: 1, pid: '1', platform: 'onebot' })
  // 先建好频道再加载插件：插件在 ready 时把白名单读进内存
  app.plugin(plugin, config)
  await app.start()
  return [app, bot]
}

/**
 * 无数据库场景：合成事件缺频道资料时，Koishi 的 autoAssign 会把 bot 自己当作受理人，
 * 因此不需要（也无法）预置 channel，直接建应用即可。
 */
async function createBareApp(config) {
  const app = new Context({})
  app.plugin(plugin, config)
  await app.start()
  const bot = addBot(app, 'onebot', '10000')
  app.command('probe', '探针').action(() => 'PONG')
  // 无数据库时白名单来自配置，触发一次刷新让它进入内存缓存（模拟真实启动时已载入的状态）
  app.emit('group-whitelist/refresh', 'onebot')
  app.emit('group-whitelist/refresh', 'qq')
  await new Promise(resolve => setTimeout(resolve, 60))
  return [app, bot]
}

/** 白名单在 ready 时载入内存，测试数据在 ready 之后才写入，因此触发刷新事件同步缓存 */
async function refresh(app) {
  app.emit('group-whitelist/refresh')
  await new Promise(resolve => setTimeout(resolve, 60))
}

/**
 * 派发合成消息，返回 bot 实际发出的文本（空字符串 = 被静默忽略）。
 * 注意 1：必须用 bot.session() 构造真实 Session，直接 dispatch 裸对象不会进入中间件链。
 * 注意 2：指令结果通过 session.send 发出，所以拦截 bot.sendMessage 而不要读 session.response。
 */
function send(app, bot, content, session) {
  const event = {
    type: 'message',
    timestamp: Date.now(),
    content,
    ...session,
  }
  if (event.guild && !event.channel) event.channel = { id: event.guild.id }
  bot.outbox = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dispatch timeout: ${content}`)), 5000)
    const dispose = app.on('middleware', () => {
      dispose()
      clearTimeout(timer)
      setImmediate(() => resolve(bot.outbox.join('')))
    })
    const sessionObj = bot.session(event)
    // 指令解析依赖 session.elements，合成事件需要手动解析
    sessionObj.elements = h.parse(content)
    bot.dispatch(sessionObj)
  })
}

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
}
const show = (value) => JSON.stringify(value)
/** 应用内部 stop() 会因为合成 bot 触发 satori 的 dispose 缺陷，测试里忽略即可 */
async function stop(app) {
  try {
    await app.stop()
  } catch { /* ignore */ }
}

async function main() {
  // ==================== 场景 1：数据库模式 ====================
  {
    const [app, bot] = await createApp(baseConfig)
    app.command('probe', '探针').action(() => 'PONG')

    await app.database.create('groupWhitelist', {
      platform: 'onebot', groupId: '100', name: '白名单群', creator: '1', createdAt: new Date(),
    })
    await refresh(app)

    check('白名单群内指令正常响应', await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } }) === 'PONG')

    let r = await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '200' }, user: { id: '1' } })
    check('非白名单群静默忽略', r === '', `got=${show(r)}`)

    r = await send(app, bot, 'probe', { platform: 'qq', guild: { id: '100' }, user: { id: '1' } })
    check('平台隔离：同群号在 qq 被忽略', r === '', `got=${show(r)}`)

    // 私聊：合成事件必须显式给出私聊频道，并把 type 标成 DIRECT，否则 isDirect 为 false
    r = await send(app, bot, 'probe', { platform: 'onebot', channel: { id: 'private:1', type: 1 }, user: { id: '1' } })
    check('私聊默认放行', r === 'PONG', `got=${show(r)}`)

    r = await send(app, bot, 'whitelist add 300', { platform: 'onebot', guild: { id: '100' }, user: { id: '2' } })
    check('无权限用户添加指令被拒绝', (await app.database.get('groupWhitelist', { groupId: '300' })).length === 0, `got=${show(r)}`)

    await app.database.set('user', { id: 1 }, { authority: 3 })
    r = await send(app, bot, 'whitelist add 300,400 500', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    const ids = (await app.database.get('groupWhitelist', { platform: 'onebot' }, ['groupId'])).map(x => x.groupId).sort()
    check('批量添加成功', ids.join(',') === '100,300,400,500', `ids=${ids.join(',')} reply=${show(r)}`)

    r = await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '300' }, user: { id: '1' } })
    check('新添加的群立即生效（缓存即时失效）', r === 'PONG', `got=${show(r)}`)

    r = await send(app, bot, 'whitelist add 300 abc 300', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('重复与非法输入被回报', r.includes('已在白名单') && r.includes('格式不正确'), `reply=${show(r)}`)

    r = await send(app, bot, 'whitelist list', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('列表展示当前平台并标记本群', r.includes('共 4 条') && r.includes('▶'), `reply=${show(r)}`)

    // 子指令必须支持点号形式的中文别名（Koishi 的指令解析按 . 切分）
    r = await send(app, bot, '白名单.列表', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('子指令 白名单.列表 可用', r.includes('共 4 条'), `reply=${show(r)}`)

    r = await send(app, bot, 'whitelist.列表', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('子指令 whitelist.列表 可用', r.includes('共 4 条'), `reply=${show(r)}`)

    r = await send(app, bot, '白名单.添加 600', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('子指令 白名单.添加 可用', (await app.database.get('groupWhitelist', { groupId: '600' })).length === 1, `reply=${show(r)}`)

    r = await send(app, bot, '白名单.移除 600', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('子指令 白名单.移除 可用', (await app.database.get('groupWhitelist', { groupId: '600' })).length === 0, `reply=${show(r)}`)

    r = await send(app, bot, 'whitelist list -p qq', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('跨平台查询 -p 生效', r.includes('qq 平台白名单') && r.includes('共 0 条'), `reply=${show(r)}`)

    // ===== 群名称：添加时抓取、列表展示、手动刷新 =====
    bot.guildNames = { 700: '测试群七零零', 701: '另一个群' }
    bot.guildCalls = []
    r = await send(app, bot, '白名单.添加 700 701', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    let names = (await app.database.get('groupWhitelist', { platform: 'onebot', groupId: { $in: ['700', '701'] } }, ['groupId', 'name']))
      .map(row => `${row.groupId}=${row.name}`).sort()
    check('添加时自动抓取群名', names.join(',') === '700=测试群七零零,701=另一个群', `names=${names.join(',')} reply=${show(r)}`)

    r = await send(app, bot, '白名单.列表', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('列表展示群名', r.includes('700（测试群七零零）') && r.includes('701（另一个群）'), `reply=${show(r)}`)

    // 平台查询失败时不应覆盖已有名称
    bot.guildNames = {}
    bot.guildCalls = []
    r = await send(app, bot, '白名单.刷新', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    names = (await app.database.get('groupWhitelist', { platform: 'onebot', groupId: { $in: ['700', '701'] } }, ['groupId', 'name']))
      .map(row => `${row.groupId}=${row.name}`).sort()
    check('刷新失败时保留原群名', names.join(',') === '700=测试群七零零,701=另一个群' && r.includes('未能取到名称'), `names=${names.join(',')} reply=${show(r)}`)

    // 群名变化后手动刷新应更新
    bot.guildNames = { 700: '改名后的群', 701: '另一个群' }
    bot.guildCalls = []
    r = await send(app, bot, '白名单.刷新', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    const renamed = (await app.database.get('groupWhitelist', { groupId: '700' }, ['name']))[0]?.name
    check('手动刷新更新群名', renamed === '改名后的群' && r.includes('已更新 1 个群'), `name=${show(renamed)} reply=${show(r)}`)
    check('手动刷新遍历该平台全部群', bot.guildCalls.length === 6, `calls=${bot.guildCalls.length} → ${bot.guildCalls.join(',')}`)

    r = await send(app, bot, '白名单.刷新 -p qq', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('指定平台刷新时名单为空则提示', r.includes('白名单为空'), `reply=${show(r)}`)

    // 名称抓取失败时不应影响添加结果（只留空名）
    bot.guildNames = {}
    r = await send(app, bot, '白名单.添加 702', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    const blank = (await app.database.get('groupWhitelist', { groupId: '702' }, ['name']))[0]?.name
    check('抓取不到群名时仍添加成功', r.includes('已向 onebot 平台添加 1 个群：702') && blank === '', `reply=${show(r)} name=${show(blank)}`)
    await send(app, bot, '白名单.移除 702', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })


    r = await send(app, bot, '白名单.移除 700 701', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })

    r = await send(app, bot, 'whitelist remove 300 999', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    const rest = (await app.database.get('groupWhitelist', { platform: 'onebot' }, ['groupId'])).map(x => x.groupId).sort()
    check('批量移除生效', rest.join(',') === '100,400,500', `rest=${rest.join(',')} reply=${show(r)}`)

    r = await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '300' }, user: { id: '1' } })
    check('移除后立即恢复拦截', r === '', `got=${show(r)}`)

    await stop(app)
  }

  // ==================== 场景 2：管理员数组 ====================
  {
    const [app, bot] = await createApp({ ...baseConfig, adminList: ['7'] })
    await app.database.create('groupWhitelist', {
      platform: 'onebot', groupId: '10', name: '', creator: '1', createdAt: new Date(),
    })
    await refresh(app)

    let r = await send(app, bot, 'whitelist add 900', { platform: 'onebot', guild: { id: '10' }, user: { id: '7' } })
    check('管理员数组单独放行（authority=1）', (await app.database.get('groupWhitelist', { groupId: '900' })).length === 1, `reply=${show(r)}`)

    r = await send(app, bot, 'whitelist add 901', { platform: 'onebot', guild: { id: '10' }, user: { id: '8' } })
    check('非管理员被拒绝', (await app.database.get('groupWhitelist', { groupId: '901' })).length === 0 && r === '', `got=${show(r)}`)

    await stop(app)
  }

  // ==================== 场景 3：无数据库降级 ====================
  {
    const [app, bot] = await createBareApp({ ...baseConfig, adminList: ['1'], fallbackGroups: ['onebot:100', 'qq:200'] })


    check('降级：平台限定项命中', await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } }) === 'PONG')
    check('降级：仅群号项对所有平台生效', await send(app, bot, 'probe', { platform: 'qq', guild: { id: '200' }, user: { id: '1' } }) === 'PONG')
    check('降级：未命中仍拦截', await send(app, bot, 'probe', { platform: 'qq', guild: { id: '999' }, user: { id: '1' } }) === '')

    let r = await send(app, bot, 'whitelist add 300', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('降级：指令提示不可用', r.includes('未注册数据库'), `reply=${show(r)}`)

    r = await send(app, bot, 'whitelist list', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('降级：列表读取配置', r.includes('来自配置项') && r.includes('100'), `reply=${show(r)}`)

    await stop(app)
  }

  // ==================== 场景 4：私聊策略与 ignoreMessage ====================
  {
    const [app, bot] = await createBareApp({ ...baseConfig, privateChat: 'whitelist', privateWhitelist: ['5'], fallbackGroups: ['1'] })


    check('私聊白名单内放行', await send(app, bot, 'probe', { user: { id: '5' } }) === 'PONG')
    check('私聊白名单外忽略', await send(app, bot, 'probe', { user: { id: '6' } }) === '')
    await stop(app)

    const [app2, bot2] = await createBareApp({ ...baseConfig, ignoreMessage: '本群未启用', fallbackGroups: ['1'] })
    const r = await send(app2, bot2, 'probe', { platform: 'onebot', guild: { id: '888' }, user: { id: '1' } })
    check('配置 ignoreMessage 时回复提示', r === '本群未启用', `got=${show(r)}`)
    await stop(app2)
  }

  // ==================== 场景 5：入群提示 ====================
  {
    const [app, bot] = await createBareApp({ ...baseConfig, fallbackGroups: ['100'], joinNoticeText: '未启用提示' })
    // 入群提示是通过 session.send 发出的，内容为元素数组，这里取首段文本比较
    const textOf = () => String(bot.outbox[0]?.[0]?.attrs?.content ?? '')

    bot.outbox = []
    bot.dispatch(bot.session({
      type: 'guild-added', timestamp: Date.now(),
      guild: { id: '777' }, user: { id: '1' }, platform: 'onebot',
    }))
    await new Promise(resolve => setTimeout(resolve, 400))
    check('入群且未在白名单 → 发送提示', bot.outbox.length === 1 && textOf() === '未启用提示', `sent=${show(bot.outbox)}`)

    bot.outbox = []
    bot.dispatch(bot.session({
      type: 'guild-added', timestamp: Date.now(),
      guild: { id: '100' }, user: { id: '1' }, platform: 'onebot',
    }))
    await new Promise(resolve => setTimeout(resolve, 400))
    check('入群且已在白名单 → 不提示', bot.outbox.length === 0, `sent=${show(bot.outbox)}`)

    await stop(app)
  }

  // ==================== 场景 6：群名定时刷新与配置模式列表 ====================
  {
    const DAY = 24 * 60 * 60 * 1000
    const app = new Context({})
    app.plugin(plugin, { ...baseConfig, adminList: ['1'], groupNameRefreshDays: 7, fallbackGroups: ['onebot:100', 'qq:200'] })
    // 拦截定时器注册，用来确认调度间隔与「自续期」行为
    const timers = []
    const realSetTimeout = app.setTimeout.bind(app)
    app.setTimeout = (callback, delay) => {
      timers.push(delay)
      return () => {}
    }
    await app.start()
    const bot = addBot(app, 'onebot', '10000')
    app.command('probe', '探针').action(() => 'PONG')
    app.emit('group-whitelist/refresh')
    await new Promise(resolve => setTimeout(resolve, 60))

    check('按配置的间隔注册群名刷新定时器', timers.filter(d => d === 7 * DAY).length === 1, `delays=${timers.join(',')}`)

    // 手动触发定时器回调，确认执行完毕后会续排下一次
    timers.length = 0
    app.setTimeout = realSetTimeout
    bot.guildNames = { 100: '配置模式群' }
    bot.guildCalls = []
    const line = await send(app, bot, '白名单.列表', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('配置模式列表展示实时拉取的群名', line.includes('100（配置模式群）'), `reply=${show(line)}`)

    bot.guildCalls = []
    await send(app, bot, '白名单.列表', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('配置模式群名有内存缓存，不重复请求', bot.guildCalls.length === 0, `calls=${bot.guildCalls.length}`)

    const app3 = new Context({})
    const timers3 = []
    app3.plugin(plugin, { ...baseConfig, groupNameRefreshDays: 0, fallbackGroups: ['100'] })
    app3.setTimeout = (callback, delay) => { timers3.push(delay); return () => {} }
    await app3.start()
    check('天数为 0 时不注册定时器', timers3.length === 0, `delays=${timers3.join(',')}`)

    await stop(app)
    await stop(app3)
  }

  // ==================== 场景 7：启动闸门 + 数据库晚到（回归测试） ====================
  // 实测环境里 database 服务比 ready 事件晚约 1 秒注入。因此插件启动后有 3 秒闸门：
  // 期间拦截全部群聊请求，之后才初始化判定表。这里断言：
  //   1) 闸门期内一律拦截（也就不会用空的 fallbackGroups 得出错误结论）；
  //   2) 闸门解除且数据库就绪后，能正常读到白名单并放行。
  {
    const sqlite = await loadSqlite()
    const app = new Context({})
    // 用 0.3 秒代替 3 秒，避免测试变慢；语义完全一致
    app.plugin(plugin, { ...baseConfig, startupDelay: 0.3 })
    await app.start()

    const bot = addBot(app, 'onebot', '10000')
    app.command('probe', '探针').action(() => 'PONG')

    // 闸门期内：数据库还没注入，消息必须被拦截
    const during = await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } })
    check('启动闸门期内拦截全部群聊', during === '', `got=${show(during)}`)

    // 数据库在闸门期内到位，且里面已经有白名单数据
    app.plugin(sqlite, { path: ':memory:' })
    await app.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    await app.database.create('channel', {
      platform: 'onebot', id: '100', guildId: '100', assignee: '10000', createdAt: new Date(),
    })
    await app.database.create('groupWhitelist', {
      platform: 'onebot', groupId: '100', name: '晚到的数据库', creator: '1', createdAt: new Date(),
    })

    // 等闸门解除
    await new Promise(resolve => setTimeout(resolve, 400))

    const rows = JSON.stringify(await app.database.get('groupWhitelist', {}, ['platform', 'groupId']))
    check('闸门解除后读到数据库白名单', await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '100' }, user: { id: '1' } }) === 'PONG', `rows=${rows}`)
    check('闸门解除后仍拦截未命中群', await send(app, bot, 'probe', { platform: 'onebot', guild: { id: '200' }, user: { id: '1' } }) === '')

    await stop(app)
  }

  // ==================== 场景 8：非消息事件（戳一戳等）与白名单服务 ====================
  // 戳一戳走 notice 事件，不经过消息流水线，插件的回应无法被 session.response 拦下。
  // 因此白名单插件对外提供 groupWhitelist 服务，供这类插件主动查询。
  {
    const [app, bot] = await createApp(baseConfig)
    app.command('probe', '探针').action(() => 'PONG')
    await app.database.create('groupWhitelist', {
      platform: 'onebot', groupId: '100', name: '', creator: '1', createdAt: new Date(),
    })
    await refresh(app)

    // 模拟 bot-poke：监听 notice 事件，先用服务判断是否允许，再决定是否发言
    console.info('DEBUGSVC typeof=' + typeof app.groupWhitelist + ' name=' + app.groupWhitelist?.constructor?.name + ' own=' + Object.keys(app.groupWhitelist ?? {}).join('|') + ' proto=' + Object.getOwnPropertyNames(Object.getPrototypeOf(app.groupWhitelist ?? {})).join('|'))
    bot.poked = []
    app.on('notice', async (session) => {
      if (session.subtype !== 'poke') return
      if (!app.groupWhitelist.isAllowed(session)) return
      bot.poked.push(session.guildId)
      await session.send('哎呀，别戳我啦~')
    })
    // 对照：完全不做判断的插件，应当由服务的判定结果说明它会被放行到哪一步
    bot.naive = []
    app.on('notice', async (session) => {
      if (session.subtype !== 'poke') return
      bot.naive.push(session.guildId)
    })

    const poke = (guildId) => {
      bot.outbox = []
      bot.dispatch(bot.session({
        type: 'notice', subtype: 'poke', timestamp: Date.now(),
        guild: { id: guildId }, channel: { id: guildId }, user: { id: '2' },
      }))
      return new Promise(resolve => setTimeout(() => resolve(bot.outbox.join('')), 150))
    }

    const allowed = await poke('100')
    check('白名单群内戳一戳正常回应', allowed === '哎呀，别戳我啦~' && bot.poked.join() === '100', `outbox=${show(allowed)} poked=${bot.poked.join()}`)

    const blocked = await poke('200')
    check('白名单外群里戳一戳不再回应', blocked === '' && bot.poked.join() === '100', `outbox=${show(blocked)} poked=${bot.poked.join()}`)

    check('服务对非白名单群返回 false', app.groupWhitelist.isAllowedGroup('onebot', '200') === false && app.groupWhitelist.isAllowedGroup('onebot', '100') === true)
    check('ctx.groupWhitelist 是 GroupWhitelist 服务实例', app.groupWhitelist instanceof plugin.GroupWhitelist, `ctor=${app.groupWhitelist?.constructor?.name}`)

    await stop(app)
  }

  // ==================== 场景 9：服务立即注册（不等 ready） ====================
  // GroupWhitelist 在构造函数里显式 ctx.set，因此其他插件的 inject 不必等到 ready。
  // 注意：服务「已注册」不等于「判定表已载入」—— 后者由启动闸门负责，
  // 未初始化期间判定一律为「不放行」，这正是 fail-closed 的预期。
  {
    const app = new Context({})
    app.plugin(plugin, { ...baseConfig, fallbackGroups: ['onebot:100'] })
    // 需要先有 bot，initialize() 才知道要载入哪个平台的白名单
    addBot(app, 'onebot', '10000')
    // 故意不调用 app.start()：此时 ready 尚未触发，服务也必须已经可用
    check('服务在 ready 之前就已注册', typeof app.groupWhitelist?.isAllowedGroup === 'function', `typeof=${typeof app.groupWhitelist}`)
    check('未初始化时判定表一律不放行', app.groupWhitelist.isAllowedGroup('onebot', '100') === false, 'fail-closed')
    await app.start()
    check('ready 之后判定恢复正常', app.groupWhitelist.isAllowedGroup('onebot', '100') === true && app.groupWhitelist.isAllowedGroup('onebot', '200') === false)
    await stop(app)
  }

  const failed = results.filter(item => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
