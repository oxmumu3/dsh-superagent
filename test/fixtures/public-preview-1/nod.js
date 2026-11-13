// dsh-superagent nod — 「等你点头」的规则判断。
//
// 只看规则、不调模型：对标题和描述做关键词匹配，三类：
//   spend      要花钱（付款、购买、充值、投流、下单…）
//   outbound   要对外（发布、发帖、群发、上线、部署、publish、push…）
//   permission 要更大权限（sudo、提权、改系统设置、生产库…）
// 拿不准时偏保守：宁可多问一次，也不替用户把钱花出去或把东西发出去。
// 这个模块不 import 任何东西，方便单测和 ledger 复用。

export const NOD_KINDS = ['spend', 'outbound', 'permission']

export const NOD_KIND_LABELS = {
  spend: '要花钱',
  outbound: '要对外发',
  permission: '要更大权限',
}

// 每条命中的「词 + 归类」。词用正则的字符串形式写，英文按不区分大小写匹配。
const RULES = [
  // 花钱
  { kind: 'spend', label: '付款', pattern: '付款' },
  { kind: 'spend', label: '支付', pattern: '支付' },
  { kind: 'spend', label: '购买', pattern: '购买' },
  { kind: 'spend', label: '买东西', pattern: '买东西' },
  { kind: 'spend', label: '采购', pattern: '采购' },
  { kind: 'spend', label: '下单', pattern: '下单' },
  { kind: 'spend', label: '充值', pattern: '充值' },
  { kind: 'spend', label: '投流', pattern: '投流' },
  { kind: 'spend', label: '投放广告', pattern: '投放广告' },
  { kind: 'spend', label: '广告费', pattern: '广告费' },
  { kind: 'spend', label: '订阅', pattern: '订阅' },
  { kind: 'spend', label: '续费', pattern: '续费' },
  { kind: 'spend', label: '转账', pattern: '转账' },
  { kind: 'spend', label: '报名费', pattern: '报名费' },
  { kind: 'spend', label: '预算', pattern: '预算' },
  { kind: 'spend', label: '付费', pattern: '付费' },
  { kind: 'spend', label: '发票报销', pattern: '报销' },
  { kind: 'spend', label: 'purchase', pattern: 'purchase' },
  { kind: 'spend', label: 'billing', pattern: 'billing' },
  // 对外
  { kind: 'outbound', label: '发布', pattern: '发布' },
  { kind: 'outbound', label: '发帖', pattern: '发帖' },
  { kind: 'outbound', label: '发推', pattern: '发推' },
  { kind: 'outbound', label: '发微博', pattern: '发微博' },
  { kind: 'outbound', label: '发公众号', pattern: '发公众号' },
  { kind: 'outbound', label: '群发', pattern: '群发' },
  { kind: 'outbound', label: '发邮件', pattern: '发邮件' },
  { kind: 'outbound', label: '发微信', pattern: '发微信' },
  { kind: 'outbound', label: '发给别人', pattern: '发给(?:别人|对方|客户|用户)' },
  { kind: 'outbound', label: '上线', pattern: '上线' },
  { kind: 'outbound', label: '部署', pattern: '部署' },
  { kind: 'outbound', label: '推送到远端', pattern: '推送' },
  { kind: 'outbound', label: 'push 到远端', pattern: 'push' },
  { kind: 'outbound', label: 'publish', pattern: 'publish' },
  { kind: 'outbound', label: 'release', pattern: 'release' },
  { kind: 'outbound', label: 'npm publish', pattern: 'npm\\s*publish' },
  { kind: 'outbound', label: 'deploy', pattern: 'deploy' },
  { kind: 'outbound', label: 'ship', pattern: '\\bship\\b' },
  // 权限
  { kind: 'permission', label: 'sudo', pattern: 'sudo' },
  { kind: 'permission', label: '提权', pattern: '提权' },
  { kind: 'permission', label: 'root', pattern: '\\broot\\b' },
  { kind: 'permission', label: '管理员权限', pattern: '管理员' },
  { kind: 'permission', label: '改系统设置', pattern: '(?:改|修改|更改)系统设置' },
  { kind: 'permission', label: '系统偏好设置', pattern: '系统偏好' },
  { kind: 'permission', label: '删除远端', pattern: '删除远端' },
  { kind: 'permission', label: '生产库', pattern: '生产(?:库|环境)' },
  { kind: 'permission', label: '线上数据库', pattern: '线上(?:库|数据库)' },
  { kind: 'permission', label: '数据库迁移', pattern: '(?:数据库|表结构)迁移' },
  { kind: 'permission', label: 'chmod', pattern: 'chmod' },
  { kind: 'permission', label: 'chown', pattern: 'chown' },
  { kind: 'permission', label: '改权限', pattern: '(?:改|修改|扩大|提升)(?:权限|授权)' },
]

const COMPILED = RULES.map(rule => ({
  ...rule,
  re: new RegExp(rule.pattern, /[a-z0-9]/i.test(rule.pattern) ? 'i' : ''),
}))

// 返回 { kinds, matched } 或 null。matched 是命中词的去重列表（保持词表顺序）。
export function detectNod(...texts) {
  const haystack = texts
    .map(value => String(value ?? ''))
    .filter(Boolean)
    .join('\n')
  if (!haystack.trim()) return null
  const kinds = []
  const matched = []
  for (const rule of COMPILED) {
    if (!rule.re.test(haystack)) continue
    if (!kinds.includes(rule.kind)) kinds.push(rule.kind)
    if (!matched.includes(rule.label)) matched.push(rule.label)
  }
  if (!kinds.length) return null
  return { kinds, matched }
}

// 面板/原因文案用的一句话：「要花钱 / 要对外发，等你点头」。
export function nodKindText(kinds = []) {
  const list = Array.isArray(kinds) ? kinds : []
  const labels = [...new Set(list.filter(kind => NOD_KIND_LABELS[kind]))].map(kind => NOD_KIND_LABELS[kind])
  if (!labels.length) return '要等你点头'
  return labels.join(' / ')
}

export function nodReason(needsNod) {
  const kinds = Array.isArray(needsNod?.kinds) ? needsNod.kinds : []
  const matched = Array.isArray(needsNod?.matched) ? needsNod.matched : []
  const head = `${nodKindText(kinds)}，等你点头`
  return matched.length ? `${head}（命中：${matched.join('、')}）` : head
}
