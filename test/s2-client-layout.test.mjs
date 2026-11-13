import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 020 的窄屏回归：只锁住这次实际改动的两条 CSS 契约。
// 不是浏览器渲染测试；宿主实机仍由 Codex 复核。
const source = fs.readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

// 普通 reset `.sa2 button` 的优先级是 0,1,1；组件类必须用两个类选择器
// （0,2,0）才能拿回 14px 内边距，否则实际 computed padding 会回到 0。
assert.match(
  source,
  /'\.sa2 \.sa2-btn\{[^']*padding:0 14px[^']*\}'/,
  '主按钮必须用 .sa2 .sa2-btn 覆盖 reset，并保留左右 14px',
)
assert.doesNotMatch(
  source,
  /'\.sa2-btn\{[^']*padding:0 14px[^']*\}'/,
  '不能再让裸 .sa2-btn 被 .sa2 button 压掉 padding',
)

// 窄屏页头从 26px 顶距改为 48px；宿主工具栏底边在 y39，首行至少 y45。
assert.match(
  source,
  /@container sa2 \(max-width:700px\)\{\.sa2-inner\{padding:48px 16px 90px\}/,
  '窄屏页头要给宿主工具栏留出至少 45px 的首行起点',
)

// 宽屏保持原样。
assert.match(
  source,
  /'\.sa2-inner\{max-width:920px;margin:0 auto;padding:40px 36px 110px;width:100%\}'/,
  '宽屏内边距不能跟着窄屏改',
)

// 493 仍同行、390 动作落到事下面：460 容器规则必须保留两列和下方动作。
assert.match(
  source,
  /@container sa2 \(max-width:460px\)\{\.sa2-row\{grid-template-columns:18px minmax\(0,1fr\);align-items:start\}\.sa2-acts\{grid-column:2;justify-content:flex-start;margin-top:8px\}/,
  '390 窄屏动作必须保持在标题下面',
)

console.log('s2-client-layout: ok')
