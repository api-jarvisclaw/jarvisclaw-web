/**
 * UI copy, keyed by the English text.
 *
 * ## Why the English string is the key
 *
 * `t('Open the console')` rather than `t('nav.console.open')`. Two reasons that matter here:
 *
 *   - a missing Chinese entry renders the English, which is the correct fallback for this audience
 *     and needs no default table. A dotted key renders as `nav.console.open` on screen — a visible
 *     defect where the fallback should have been invisible;
 *   - the source stays readable. A reviewer reads what the user sees, in place, instead of holding
 *     a key namespace in their head.
 *
 * The cost is real and worth stating: changing the English wording orphans the translation
 * silently. `strings.test.ts` guards it — it reads the source, collects every `t('…')` argument,
 * and fails on a call whose key is not in this file. That check is the whole reason this scheme is
 * safe, so do not delete it in a cleanup.
 *
 * ## What is NOT here
 *
 * Prompt data (`library.ts`, `seedance.ts`, `showcase.ts`). Those are other people's work under
 * licences that ask for it to travel intact, and a translated prompt is a different prompt that
 * produces a different image. The prompts stay in the language their author wrote them in; the
 * chrome around them is translated.
 *
 * Model ids, prices and API paths are not copy either. `openai/gpt-image-2` is the same string in
 * every language, and translating `$0.064` would be a lie about the currency.
 */

import type { Locale } from './i18n'

/**
 * Chinese copy. English keys with no entry here fall through to the key itself.
 *
 * Written, not machine-translated: this app takes money, and a mistranslated spend prompt is worse
 * than an English one. Where a term has no good Chinese equivalent in this domain (x402, USDC,
 * agent) it is left in English on purpose, because that is what the people using it call it.
 */
const zh: Record<string, string> = {
  // ---- nav and shell ----
  'Open the console': '打开控制台',
  Docs: '文档',
  Platform: '平台',
  Blog: '博客',
  Start: '开始',
  'JarvisClaw home': 'JarvisClaw 首页',
  Sections: '目录',
  // The three in-page anchors. Caught by the nav-label gate, which is the whole reason that gate
  // exists: they are rendered as t(item.label), so the static scan could not see them missing.
  Compare: '对比',
  Pricing: '价格',
  FAQ: '常见问题',
  Marketplace: 'API 市场',
  Gallery: '作品库',
  'New chat': '新对话',
  Wallet: '钱包',
  close: '关闭',

  // ---- landing page ----
  'The browser agent with a wallet': '带钱包的浏览器 agent',
  'Ask for anything.': '想要什么，直接说。',
  'It pays per call.': '按次付费。',
  'models, one chat box': '个模型，一个对话框',
  'free right now, no credential': '个当前免费，无需凭据',
  'callable APIs, priced per call': '个可调用 API，按次计价',
  'categories to browse': '个分类可浏览',
  'How it works': '怎么用',
  'Three ways to pay, and one of them is free': '三种付费方式，其中一种免费',
  'Which one you use is a choice you make when you need to, not a decision at the door.':
    '用哪种，等你需要的时候再选，不是进门就得决定。',
  'Free, right now': '现在就免费',
  'A wallet, per call': '钱包，按次付',
  'An account you already have': '你已有的账号',
  'Sign in on the platform and spend the quota on it. Your existing key works here the same way it works everywhere else.':
    '在平台登录后使用账号额度。你现有的 key 在这里和在别处一样能用。',
  'Or run it in your terminal': '也可以在终端里跑',

  // ---- hero chips ----
  'No sign-up': '不用注册',
  'No card': '不用银行卡',
  'Price before every charge': '每笔扣款前先报价',

  // ---- the three steps ----
  'Ask for what you want': '说出你想要什么',
  'Plain language. The agent picks the model or the API — you do not have to know which one exists.':
    '用日常语言。模型和 API 由 agent 挑，你不需要知道有哪些。',
  'See the price first': '先看价格',
  'Anything that costs money is quoted before it runs, and you approve that exact amount. Nothing is charged on a guess.':
    '任何要花钱的操作都会先报价，由你确认那个确切金额。绝不按估算扣款。',
  'Keep what it makes': '产出归你',
  'Images, video, music and speech are collected in your gallery with what each one cost, and every row says how long that file lasts.':
    '图片、视频、音乐和语音都会收进你的作品库，并标注各自花了多少钱，每一条还会写明这个文件能存多久。',
  'One npm install, Node 20+. The same gateway, the same per-call pricing, no browser.':
    '一条 npm install，Node 20+。同一个网关、同样的按次计价，不需要浏览器。',
  'Start free': '免费开始',
  'The free models need no wallet and no key, in the terminal exactly as they do here.':
    '免费模型不需要钱包也不需要 key，终端里和这里完全一样。',
  'Fund it when you need more': '需要更多时再充值',
  'Read the CLI docs': '查看 CLI 文档',
  'What is actually here': '这里到底有什么',
  'Prompts that already worked': '已经验证过的提示词',
  'The same API from your own code': '在你自己的代码里调同一个 API',
  'This console is one client of a public HTTP API. Anything you can do here works from the CLI or an SDK against the same gateway, at the same per-call price.':
    '这个控制台只是一个公开 HTTP API 的客户端。这里能做的一切，都可以用 CLI 或 SDK 打同一个网关完成，价格一样。',
  'The same question, three ways to answer it': '同一个问题，三种答法',
  'A chat subscription': '聊天订阅制',
  'Raw API keys': '裸 API key',
  'This console': '这个控制台',
  'What stays yours': '什么始终属于你',
  'Questions people actually ask': '大家真正会问的问题',
  'Type something and see what it costs.': '随便输一句，看看它要多少钱。',
  'The free models need nothing from you.': '免费模型不需要你提供任何东西。',
  'What should it do?': '想让它做什么？',

  // ---- the comparison table ----
  //
  // Three columns: a chat subscription, raw API keys, this console. The rows are claims about other
  // products, so the Chinese stays as factual as the English — an overstated comparison is worse in
  // a second language, because the reader cannot check it against the original.
  'What it can reach': '能用到什么',
  'The models that vendor hosts. A video or an on-chain lookup is a different product.':
    '只有那家厂商自己托管的模型。视频或链上查询是另一个产品。',
  'Whatever you have signed up for, one account and one key at a time.':
    '你注册过的那些，一个账号配一个 key，逐个来。',
  'Every model and every callable API behind one box — chat, image, video, music, speech, data.':
    '一个输入框后面是全部模型和全部可调用 API —— 对话、图片、视频、音乐、语音、数据。',
  'What you pay': '怎么付钱',
  'A monthly fee, whether you used it or not.': '按月付，用不用都收。',
  'Per token, per provider, on a card that has to clear first.':
    '按 token、按厂商分别计费，还得先绑一张能过账的卡。',
  'Per call, quoted before it runs, and you approve that exact amount.':
    '按次计费，跑之前先报价，你确认那个确切金额。',
  'To start': '开始要什么',
  'Email, password, card.': '邮箱、密码、银行卡。',
  'An account and a key per provider, each with its own billing.':
    '每个厂商一个账号一个 key，各自独立计费。',
  'Nothing. The free models answer with no credential at all.':
    '什么都不要。免费模型完全不需要凭据就能回答。',
  'When you run out': '用超了会怎样',
  'Rate limits, usually when you need it most.': '限速，而且往往就在你最需要的时候。',
  'A failed call and an email about your card.': '调用失败，然后收到一封关于你银行卡的邮件。',
  'It stops. The wallet balance and your session budget are the only caps.':
    '它停下来。钱包余额和你的会话预算是唯一的上限。',
  'What it knows about you': '它知道你什么',
  'An account, a history, and a payment profile.': '一个账号、一份历史记录、一份支付档案。',
  'One account per provider.': '每个厂商一个账号。',
  'Nothing, if you use it anonymously. Conversations stay in this browser.':
    '匿名使用的话，什么都不知道。对话只留在这个浏览器里。',

  // ---- what stays yours ----
  'Your keys': '你的密钥',
  'Private keys never leave your wallet. This page asks it to sign each payment and never sees one. An API key, if you use one, is held in that tab only and never stored.':
    '私钥永远不离开你的钱包。这个页面只是请钱包为每笔支付签名，从不接触私钥。如果你用 API key，它只存在于那个标签页里，绝不写入存储。',
  'They never leave your wallet. This page asks it to sign each payment and never sees a private key. An API key, if you use one, is held in that tab only and never stored.':
    '它们永远不离开你的钱包。这个页面只是请钱包为每笔支付签名，从不接触私钥。如果你用 API key，它只存在于那个标签页里，绝不写入存储。',
  'Your conversations': '你的对话',
  'The transcript lives in this browser, not in an account. That cuts both ways and the FAQ says so: nothing to leak, and nothing that follows you to another device.':
    '对话记录存在这个浏览器里，不在任何账号里。这一点是双刃剑，FAQ 里也照实说了：没有可泄露的东西，也没有能跟你换设备的东西。',
  'Your way out': '你的退出通道',
  'This console is one client of a public HTTP API. The CLI, an SDK or plain curl reach the same gateway at the same per-call price, so nothing here is the only door.':
    '这个控制台只是一个公开 HTTP API 的客户端。CLI、SDK 或者一条 curl 都能以同样的按次价格打到同一个网关，所以这里从来不是唯一的门。',

  // ---- FAQ. Two of these are uncomfortable on purpose; the Chinese keeps them so ----
  'Do I need an account?': '需要注册账号吗？',
  'No. The free models answer with no credential at all — no key, no wallet, no card. An account or a wallet is only needed to reach paid models and the callable APIs.':
    '不需要。免费模型完全不需要凭据就能回答 —— 不要 key、不要钱包、不要卡。只有用付费模型和可调用 API 时才需要账号或钱包。',
  'How do I know what something costs before I pay?': '付款前怎么知道要花多少钱？',
  'Every paid call is quoted first and you approve that exact amount. Per-token models show their rate in the picker; per-call ones cannot be known from a rate card, so the gateway returns a quote for your specific request and the dialog shows it.':
    '每一次付费调用都先报价，由你确认那个确切金额。按 token 计费的模型在选择器里显示单价；按次计费的没法从价目表推出来，所以网关会针对你这一次请求返回报价，对话框把它显示出来。',
  'Where does my generated media go?': '我生成的内容存在哪？',
  'Most of it is copied to our own CDN and kept with no expiry. Some cannot be — an archive can fail, and speech arrives as raw bytes with no URL to copy from — so every row in the gallery says which case it is and warns you when a file is on a clock. Download the ones that are.':
    '大部分会复制到我们自己的 CDN 并长期保存。有些做不到 —— 归档可能失败，语音是裸字节没有可复制的 URL —— 所以作品库每一行都会说明属于哪种情况，并在文件有时限时提醒你。有时限的请下载保存。',
  'Is my conversation history saved?': '对话历史会保存吗？',
  'In this browser. There is no account to attach it to, so clearing site data loses the list and it does not follow you to another device. Media that reached the CDN survives either way; the transcript does not.':
    '存在这个浏览器里。没有账号可以挂靠，所以清除站点数据就会丢掉这个列表，它也不会跟你换设备。已经传到 CDN 的媒体两种情况下都还在，但对话记录不会。',
  'What happens to my wallet keys?': '我的钱包私钥会怎样？',
  'Can I use this from my own code?': '能在我自己的代码里用吗？',
  'Yes — this console is one client of a public HTTP API. Anything you can do here you can do from the CLI or an SDK against the same gateway, with the same per-call pricing.':
    '可以 —— 这个控制台只是一个公开 HTTP API 的客户端。这里能做的一切，都可以用 CLI 或 SDK 打同一个网关完成，价格一样按次计。',

  // ---- the side panels ----
  //
  // Money words, so they follow the platform's own Chinese rather than a literal rendering: 支出 for
  // spend and 余额 for balance are what the gateway's own UI uses, and two names for one number is
  // how someone concludes they are looking at different figures.
  'This session': '本次会话',
  Spent: '已花费',
  'Budget left': '剩余预算',
  Charges: '支出明细',
  Limits: '限额',
  Account: '账户',
  'Signed in': '已登录',
  Balance: '余额',

  // ---- sign-in. The first thing a paying user touches ----
  //
  // 'API key' and 'key' stay in English: that is what the platform's own UI calls them and what the
  // docs call them, and inventing a Chinese term for a credential the user has to go and find under
  // an English label is how someone concludes they are looking for a different thing.
  'Checking for a signed-in session…': '正在检查登录状态…',
  'Sign in to use quota you already have on JarvisClaw. Your key works here exactly as it does on the platform.':
    '登录后即可使用你在 JarvisClaw 上已有的额度。你的 key 在这里和在平台上用法完全一样。',
  'Sign in to JarvisClaw': '登录 JarvisClaw',
  'New here? Create an account': '第一次来？注册一个账号',
  "I've signed in": '我已经登录了',
  'No account needed for free models, or to pay per call with a wallet.':
    '用免费模型、或者用钱包按次付费，都不需要账号。',
  'API key': 'API key',
  'use wallet instead': '改用钱包',
  'in use for paid calls': '正用于付费调用',
  'Loading your keys…': '正在加载你的 key…',
  'Make one': '新建一个',
  'Sign out': '退出登录',
  'The key is held for this tab only and never saved. Signing out drops it.':
    'key 只保存在这个标签页里，绝不写入存储。退出登录即丢弃。',

  // ---- composer and chat ----
  'Connect wallet': '连接钱包',
  'Waiting for your wallet…': '等待你的钱包确认…',
  Disconnect: '断开连接',
  Prompt: '提示词',

  // ---- spend consent. The most important strings in the app ----
  'Approve this charge?': '确认这笔支出？',
  "Don't spend": '不花',
  Approve: '确认支付',

  // ---- gallery ----
  'Prompt gallery': '提示词展示',
  'Video prompts': '视频提示词',
  'Prompt library': '提示词库',
  'Your creations': '你的作品',
  'Real prompts you can copy': '可以直接抄的真实提示词',
  'Nothing here yet': '这里还没有东西',
  'Copy prompt': '复制提示词',
  Copied: '已复制',
  'Make your own': '做一个你自己的',
  'Prompts that were tested': '经过验证的提示词',
  'search prompts': '搜索提示词',
  'search endpoints': '搜索接口',
  All: '全部',

  // ---- marketplace ----
  //
  // The headline is assembled from parts, and the plural pair is why: English needs
  // category/categories, Chinese needs neither. Both English forms map to the SAME Chinese string,
  // which is correct rather than a duplicate — the distinction does not exist in the target.
  Categories: '分类',
  'Loading the catalogue…': '正在加载目录…',
  'Named services': '具名服务',
  'Ask the agent': '让 agent 去调',
  Previous: '上一页',
  Next: '下一页',
  '{n} category': '{n} 个分类',
  '{n} categories': '{n} 个分类',
  '{n} picks across {cats}, chosen for a first look.': '{cats}，共 {n} 个精选，供你先看一眼。',
  '{n} callable endpoints across {cats}.': '{cats}，共 {n} 个可调用接口。',
  'Paid per call — the agent asks before it spends.': '按次付费 —— agent 花钱前会先问你。',

  // ---- composer, model picker, options ----
  //
  // `auto` and `free` are the literal model-name prefixes the gateway serves (auto/free, auto/tts),
  // so they stay in English on the badge: a Chinese label over a name the user must type as `auto/`
  // is a mismatch between the UI and the API.
  Send: '发送',
  'Generation options': '生成选项',
  // GENERATIONS[kind].label from lib/modality.ts, rendered as t(...) so the scan cannot see them —
  // gated by their own test, which reads modality.ts directly.
  Image: '图片',
  Video: '视频',
  Music: '音乐',
  Speech: '语音',
  'Prompt categories': '提示词分类',
  auto: 'auto',
  'not servable': '当前无法服务',

  // ---- the console's empty state ----
  //
  // Split around the product name, which is never translated. The two halves are separate keys
  // because Chinese puts the verb after the object — 「JarvisClaw 来做什么？」 needs the second half
  // to carry the whole question, and a single key with the name interpolated would force English
  // word order onto it.
  'The agent with a wallet': '带钱包的 agent',
  'What should': '想让',
  'do?': '做什么？',

  // ---- the wallet panel's blurbs ----
  'Paid models and callable APIs are paid per call in USDC on Base. Install a browser wallet to use them — free models work without one.':
    '付费模型和可调用 API 按次用 Base 上的 USDC 付款。装一个浏览器钱包就能用 —— 免费模型不需要钱包。',
  'Connect a wallet to reach paid models and callable APIs. Every charge is signed by you, in your wallet, showing the exact amount before it happens.':
    '连接钱包即可使用付费模型和可调用 API。每一笔都由你在自己的钱包里签名，扣款前先显示确切金额。',
  'Payments settle on Base. Switch network to pay.': '支付在 Base 上结算。请切换网络后付款。',
  'Your keys stay in your wallet. This page never sees them, and nothing is stored — a reload asks again.':
    '你的密钥始终留在钱包里。本页面从不接触它们，也不做任何存储 —— 刷新后会再次询问。',
  // The host is interpolated rather than written into the sentence: it is a real domain that must
  // match the deployment, and a translated copy of it would be a dead link.
  'Reading your session only works from {host}. On this origin, paste-free sign-in is unavailable — use a wallet, or the free models.':
    '读取登录状态只能在 {host} 上进行。在当前域名下无法免粘贴登录 —— 请用钱包，或者用免费模型。',
  "Your wallet still asks you to sign every payment. These limits control this page's own prompts and its spending ceiling.":
    '钱包仍然会要求你为每一笔支付签名。这里的限额控制的是本页面自己的提示和消费上限。',

  // ---- the conversation rail ----
  'Search chats': '搜索对话',
  'search your chats': '搜索你的对话',
  'No conversations yet.': '还没有对话。',
  'Install CLI': '安装 CLI',
  'A generation is still running in this chat': '这个对话里还有生成任务在跑',
  // Interpolated so the title stays out of the translation — a conversation title is user content
  // and must not be reworded by anything here.
  'Delete {title}': '删除 {title}',

  // ---- the wallet panel ----
  //
  // Base and USDC stay in English (proper names), and `Max per signature` is the safety limit the
  // error message about refusing to sign refers back to — the two must use the same words or the
  // refusal will not point anywhere the reader can find.
  'Get a wallet': '获取一个钱包',
  Address: '地址',
  Network: '网络',
  'Max per signature': '单笔签名上限',

  // ---- the transcript ----
  //
  // These are the words on a tool row, and two of them carry money: `free` says a call cost nothing
  // and `not called — needs payment` says why an answer is missing. A vague translation of either
  // one makes the spend record unreadable, which is the one thing this product cannot afford.
  Thinking: '思考中',
  'answered by': '回答者',
  'Open original': '打开原文件',
  declined: '已拒绝',
  running: '进行中',
  'not called — needs payment': '未调用 —— 需要付费',
  free: '免费',

  // ---- the seedance pane ----
  //
  // `clip` vs `frame` is the distinction the whole pane is built on: only 5 of 105 have a playable
  // video. 可播片段 / 静帧 keeps that difference visible — collapsing them would put a play control
  // over an image that cannot move.
  'Video prompts that worked': '真正跑通过的视频提示词',
  clip: '可播片段',
  frame: '静帧',
  'original post': '原帖',
  'watch it there': '去那里看',
  Close: '关闭',
  '{n} chars': '{n} 字符',
  // The cue works both ways now. `written in English` has no Chinese-facing counterpart in the old
  // copy, which is why 73 of the 105 seedance prompts arrived unannounced for a Chinese reader.
  'written in Chinese': '中文写的',
  'written in English': '英文写的',

  // ---- the prompt library ----
  '{video} are video shot descriptions with camera moves and physics notes; the other {image} restyle an image you upload. Most carry the author’s own aspect ratio, duration and negative prompt.':
    '其中 {video} 条是带镜头运动和物理说明的视频分镜，另外 {image} 条用来改写你上传的图片。大部分都带了作者自己的画面比例、时长和负向提示词。',
  // Only shown to a non-Chinese reader — see LibraryPane. Kept in the catalogue anyway so a future
  // locale gets it, and because the drift guard has no way to know a string is conditional.
  'Every prompt here is written in Chinese, by its author. They work as written — the models read Chinese — and are left untranslated because a reworded prompt is a different prompt.':
    '这里每一条提示词都是作者用中文写的。它们照原样就能用（模型读得懂中文），我们不做翻译 —— 改过措辞的提示词就是另一条提示词。',

  // ---- error messages ----
  //
  // Translated where they are DISPLAYED (see lib/errors.ts), because they are thrown from plain
  // modules with no React. These are the sentences that explain why money did not move, so each one
  // has to say what the reader can DO — a vague translation here turns a fixable refusal into an
  // apparent malfunction.
  //
  // Chain ids, USDC, Base, MetaMask, Rabby, IndexedDB stay in English: they are proper names, and a
  // Chinese rendering of "Base" would send someone looking for a network that does not exist.
  'No wallet found. Install a browser wallet such as MetaMask or Rabby.':
    '没有检测到钱包。请安装一个浏览器钱包，比如 MetaMask 或 Rabby。',
  'No wallet found.': '没有检测到钱包。',
  'The wallet returned no account.': '钱包没有返回账户。',
  'The wallet returned an unreadable chain id.': '钱包返回的 chain id 无法识别。',
  'The wallet returned no signature.': '钱包没有返回签名。',
  'The gateway quoted no EVM payment option, so a browser wallet cannot pay it.':
    '网关没有给出 EVM 付款方式，浏览器钱包无法支付。',
  'The gateway quoted no recipient address.': '网关没有给出收款地址。',
  'The gateway quoted an asset other than USDC, which this page will not sign for.':
    '网关报价用的不是 USDC，本页面不会为此签名。',
  'The gateway quoted an invalid amount ({amount}).': '网关给出的金额无效（{amount}）。',
  'Refusing to sign ${usd} — above your ${cap} per-signature cap. Raise it in Limits if you meant to.':
    '拒绝签名 ${usd} —— 超过你设定的单笔上限 ${cap}。如果确实要签，请到「限额」里调高。',
  'Unrecognised network {network}.': '无法识别的网络 {network}。',
  'Your wallet is on chain {have} but this payment is on {want}. Switch network and try again.':
    '你的钱包在 chain {have}，而这笔支付在 {want}。请切换网络后重试。',
  'the gateway quoted no usable price for this call': '网关没有为这次调用给出可用价格',
  // Not thrown — yielded as an agent event's `text`, so the new-Error scan cannot see it. Copied
  // verbatim from agent.ts; my first attempt at this key was a paraphrase and matched nothing, which
  // is silently the same as having no translation.
  'The gateway did not accept the payment. Check the wallet has USDC on Base.':
    '网关没有接受这笔支付。请检查钱包在 Base 上是否持有 USDC。',
  '{model} is listed but not currently servable — pick another model':
    '{model} 已上架但当前无法服务 —— 请换一个模型',
  'the gateway answered {status} when asked to price this {unit}':
    '请求 {unit} 报价时，网关返回了 {status}',
  '{what} generation failed ({status})': '{what} 生成失败（{status}）',
  'the platform returned no data': '平台没有返回数据',
  'the platform returned no key': '平台没有返回 key',
  'IndexedDB is unavailable': 'IndexedDB 不可用',
  'could not open the media store': '无法打开媒体存储',
  'the media store is blocked by another tab': '媒体存储被另一个标签页占用',
  'media store request failed': '媒体存储请求失败',
}

const CATALOGUE: Record<Locale, Record<string, string>> = { en: {}, zh }

/**
 * Looks up one string.
 *
 * Falls back to the key, which IS the English copy — see the header. Never throws: a missing
 * translation must degrade to a readable screen, not to a blank one.
 *
 * `vars` interpolates `{name}` placeholders. Deliberately minimal — no plural rules, no date
 * formatting. Two locales of UI chrome do not need them, and the numbers this app shows are
 * currency amounts formatted by the caller.
 */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const table = CATALOGUE[locale]
  let out = (table && table[key]) || key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v))
    }
  }
  return out
}

/** Every English key this file knows about, for the drift guard in strings.test.ts. */
export function knownKeys(): string[] {
  return Object.keys(zh)
}

/** How much of the UI a locale actually covers, used by the coverage test. */
export function coverage(locale: Locale): number {
  return Object.keys(CATALOGUE[locale] ?? {}).length
}
