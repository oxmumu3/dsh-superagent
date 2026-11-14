// dsh-superagent — 浏览器端 half（client bundle）。
//
// 手写 CJS + window.__ModuleLoader__ 包装，零构建。**不能出现 ESM 的 export。**
// 挂载点按宿主槽位目录的精确契约：
//   sidebar.panellist        list   注册 { id, order, label }，组件收 { size, active }
//   sidebar.session.action   hoc    包裹左栏「新建会话」行，提供就地快速记任务入口（仅 Super Agent 使用）
//   main                     keyed  注册 { key }，组件是面板本体（含 RC3 workspace.picker 工厂槽位接入）
// 数据走宿主 HTTP 路由 /api/superagent/view、/api/superagent/action、
// /api/superagent/card（见 lib/route.js）。

window.__ModuleLoader__.load({
  id: '@oxmumu3/dsh-superagent',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    var PANEL_KEY = 'superagent'
    var VIEW_URL = '/api/superagent/view'
    var ACTION_URL = '/api/superagent/action'
    var CARD_URL = '/api/superagent/card'
    // S4：「打开会话」优先用宿主的 uiWorkspace；拿不到就退回复制会话编号。
    // RC3：补充 workspaces / sessions / slots，用来渲染 sidebar.session.action 与 workspace.picker。
    var hostUi = { openSession: null, canOpen: false, workspaces: null, sessions: null, slots: null }
    var boardListeners = new Set()

    function notifyBoardUpdated() {
      boardListeners.forEach(function (fn) {
        try { fn() } catch (error) {}
      })
    }

    function loadReact() {
      try {
        var mod = require('react')
        return mod && mod.createElement ? mod : mod && mod.default
      } catch (error) {
        return null
      }
    }

    function loadReactDom() {
      try {
        var mod = require('react-dom')
        return mod && mod.createPortal ? mod : mod && mod.default
      } catch (error) {
        return null
      }
    }

    function normalizeDir(path) {
      return String(path || '').replace(/\/+$/, '')
    }

    function hasWorkspacePickerFactory(slots) {
      if (!slots) return false
      if (typeof slots.snapshot === 'function') {
        var snap = slots.snapshot('factory:workspace.picker')
        return Array.isArray(snap) && snap.length > 0
      }
      if (typeof slots.spec === 'function') {
        return Boolean(slots.spec('workspace.picker.directoryFlow'))
      }
      if (typeof slots.factory === 'function') {
        return Boolean(slots.factory('workspace.picker'))
      }
      return false
    }

    function subscribeWorkspacePickerFactory(slots, listener) {
      if (!slots || typeof listener !== 'function') return null
      var unsubs = []
      if (typeof slots.subscribe === 'function') {
        unsubs.push(slots.subscribe('workspace.picker.directoryFlow', listener))
      }
      if (typeof slots.subscribeFactory === 'function') {
        unsubs.push(slots.subscribeFactory('workspace.picker', listener))
      }
      if (!unsubs.length) return null
      return function () {
        for (var i = 0; i < unsubs.length; i += 1) {
          if (typeof unsubs[i] === 'function') unsubs[i]()
        }
      }
    }

    function canUseWorkspacePicker(props) {
      return Boolean(
        hasWorkspacePickerFactory(hostUi.slots)
        && props
        && typeof props.renderFactorySlot === 'function'
      )
    }

    function listHostWorkspaceItems() {
      var list = hostUi.workspaces && hostUi.workspaces.list
      if (!list || typeof list.getSnapshot !== 'function') return []
      var snap = list.getSnapshot()
      var items = (snap && Array.isArray(snap.items)) ? snap.items : []
      return items.filter(function (row) {
        return row && (row.path || row.directory)
      }).map(function (row) {
        var p = row.path || row.directory
        var dir = normalizeDir(p) || String(p)
        var parts = dir.split('/')
        var fallbackName = parts[parts.length - 1] || dir
        return {
          id: row.workspaceId || row.id || dir,
          path: p,
          label: row.title || row.name || fallbackName,
        }
      })
    }

    function pathByWorkspaceId(wsId) {
      if (!wsId) return null
      var items = listHostWorkspaceItems()
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].id === wsId) return items[i].path
      }
      return null
    }

    function workspaceIdByPath(wsPath) {
      var target = normalizeDir(wsPath)
      if (!target) return undefined
      var items = listHostWorkspaceItems()
      for (var i = 0; i < items.length; i += 1) {
        if (normalizeDir(items[i].path) === target) return items[i].id
      }
      return undefined
    }

    function activeForegroundWorkspacePath() {
      var list = hostUi.sessions && hostUi.sessions.list
      if (!list || typeof list.getSnapshot !== 'function') return null
      var snap = list.getSnapshot()
      var byId = snap && snap.byId
      if (!byId || typeof byId !== 'object') return null
      var keys = Object.keys(byId)
      for (var i = 0; i < keys.length; i += 1) {
        var row = byId[keys[i]]
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0 && row.workspaceId) {
          var p = pathByWorkspaceId(row.workspaceId)
          if (p) return p
        }
      }
      return null
    }

    var GROUPS = ['waiting', 'running', 'queued', 'later', 'doneToday']
    var WAITING_STAGES = ['not_started', 'not_delivered', 'approval', 'question', 'review', 'stuck', 'silent']
    var STAGE_WORD = {
      not_started: '还没开始',
      not_delivered: '待定',
      approval: '等你批',
      question: '等你回答',
      review: '待你验收',
      stuck: '卡住了',
      silent: '好久没动静',
      working: '正在跑',
      queued: '排队中',
      later: '以后再说',
      closed: '已做完',
    }
    var META = {
      waiting: {
        label: '等你',
        hint: '只有你能把一件事变成做完',
        empty: '现在没有事在等你。',
      },
      running: {
        label: '在跑',
        hint: '每件事后面写着正在做它的会话',
        empty: '现在没有会话在跑。',
      },
      queued: {
        label: '排队',
        hint: '自动排队的到点就开工；老卡要你点开始',
        empty: '没有排队的事。',
      },
      later: {
        label: '以后再说',
        hint: '先放着的，点「排进去」',
        empty: '没有先放着的事。',
      },
      doneToday: {
        label: '今天做完',
        hint: '今天你验收过的',
        empty: '今天还没有验收过的事。',
      },
    }

    var OUTCOME = {
      ready: '待验收',
      progress: '还在做',
      waiting: '在等外部',
      blocked: '卡住了',
      failed: '做不下去',
      dropped: '不用做了',
    }

    var ASSIGNMENT = {
      pending: '正在起会话',
      running: '在跑',
      idle: '这一轮停了',
      ended: '已结束',
    }

    var END_REASON = {
      done: '完成',
      canceled: '取消',
      superseded: '换会话',
      lost: '失联',
    }

    var END_KIND = {
      completed: '正常结束',
      aborted: '被打断',
      blocked: '被拦下',
      error: '出错',
      'max-tokens': '超出长度',
      interrupted: '中断',
    }

    // 颜色只用宿主语义 token；回退值只在宿主变量缺失时兜底（支持明暗双主题与宿主 data-ds-dark-theme）。
    var DARK_VARS = [
      '--sa2-ink:var(--dsw-alias-label-primary,#eef0f3);',
      '--sa2-ink2:var(--dsw-alias-label-secondary,#b6bcc6);',
      '--sa2-ink3:var(--dsw-alias-label-tertiary,#868d99);',
      '--sa2-ink4:var(--dsw-alias-label-caption,#565d68);',
      '--sa2-bg:var(--dsw-alias-bg-base,#111214);',
      '--sa2-card:var(--dsw-alias-bg-layer-2,#181a1e);',
      '--sa2-sub:var(--dsw-alias-bg-layer-1,#1e2127);',
      '--sa2-line:var(--dsw-alias-border-l2,#2a2e36);',
      '--sa2-line2:var(--dsw-alias-border-l4,#383d48);',
      '--sa2-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));',
      '--sa2-run:var(--dsw-alias-link,#728eff);',
      '--sa2-wait:var(--dsw-alias-state-warn-primary,#f0aa3c);',
      '--sa2-stuck:var(--dsw-alias-state-error-primary,#f0716b);',
      '--sa2-ok:var(--dsw-alias-state-success-primary,#4cc380);',
    ].join('')
    var LIGHT_VARS = [
      '--sa2-ink:var(--dsw-alias-label-primary,#17191c);',
      '--sa2-ink2:var(--dsw-alias-label-secondary,#4a4f57);',
      '--sa2-ink3:var(--dsw-alias-label-tertiary,#767c86);',
      '--sa2-ink4:var(--dsw-alias-label-caption,#a6abb3);',
      '--sa2-bg:var(--dsw-alias-bg-base,#f7f7f5);',
      '--sa2-card:var(--dsw-alias-bg-layer-2,#fff);',
      '--sa2-sub:var(--dsw-alias-bg-layer-1,#f2f2ee);',
      '--sa2-line:var(--dsw-alias-border-l2,#e6e6e1);',
      '--sa2-line2:var(--dsw-alias-border-l4,#cfcfc8);',
      '--sa2-hover:var(--dsw-alias-interactive-bg-hover,rgba(23,25,28,.05));',
      '--sa2-run:var(--dsw-alias-link,#4d6bfe);',
      '--sa2-wait:var(--dsw-alias-state-warn-primary,#c97a00);',
      '--sa2-stuck:var(--dsw-alias-state-error-primary,#d0453f);',
      '--sa2-ok:var(--dsw-alias-state-success-primary,#2f8a57);',
    ].join('')
    var CSS = [
      '.sa2{' + LIGHT_VARS,
      '--sa2-sans:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif);',
      '--sa2-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;',
      '--sa2-ease:cubic-bezier(.2,.8,.2,1);',
      'min-height:100%;background:var(--sa2-bg);color:var(--sa2-ink);',
      'font:14px/22px var(--sa2-sans);-webkit-font-smoothing:antialiased;container-type:inline-size;container-name:sa2}',
      '@media (prefers-color-scheme:dark){.sa2{' + DARK_VARS + '}}',
      'body[data-ds-dark-theme="true"] .sa2,body[data-theme="dark"] .sa2,.sa2[data-theme="dark"]{' + DARK_VARS + 'color-scheme:dark}',
      'body[data-ds-dark-theme="false"] .sa2,body[data-theme="light"] .sa2,.sa2[data-theme="light"]{' + LIGHT_VARS + 'color-scheme:light}',
      '.sa2,.sa2 *{box-sizing:border-box}',
      ':where(.sa2) :is(h1,h2,h3,p,ul,ol,figure){margin:0;padding:0}',
      ':where(.sa2) :is(ul,ol){list-style:none}',
      ':where(.sa2) button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',
      ':where(.sa2) input,:where(.sa2) textarea{font:inherit;color:inherit}',
      '.sa2 :focus-visible{outline:2px solid var(--sa2-run);outline-offset:2px;border-radius:4px}',
      '@media (prefers-reduced-motion:reduce){.sa2 *{animation:none!important;transition:none!important}}',
      '.sa2-inner{max-width:920px;margin:0 auto;padding:40px 36px 110px;width:100%}',
      '.sa2-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.sa2-eyebrow{display:flex;align-items:center;gap:10px;font:11px/16px var(--sa2-mono);letter-spacing:.1em;color:var(--sa2-ink3);text-transform:uppercase}',
      '.sa2-status-pills{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sa2 .sa2-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);font-size:12px;line-height:18px;color:var(--sa2-ink2);white-space:nowrap;transition:background .16s var(--sa2-ease),border-color .16s var(--sa2-ease)}',
      '.sa2 .sa2-pill:hover{background:var(--sa2-hover);border-color:var(--sa2-ink3)}',
      '.sa2-pill.has-vent{border-color:color-mix(in srgb,var(--sa2-wait) 45%,var(--sa2-line2))}',
      '.sa2-dot{width:7px;height:7px;border-radius:50%;background:var(--sa2-ink4);flex:none}',
      '.sa2-dot.auto{background:var(--sa2-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-ok) 18%,transparent)}',
      '.sa2-dot.observe{background:var(--sa2-wait);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-wait) 18%,transparent)}',
      '.sa2-badge-num{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--sa2-sub);font:600 11px/18px var(--sa2-mono);color:var(--sa2-ink2)}',
      '.sa2-live{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border:1px solid var(--sa2-line2);border-radius:999px;letter-spacing:.02em;text-transform:none;font-family:var(--sa2-sans)}',
      '.sa2-live i{width:6px;height:6px;border-radius:50%;background:var(--sa2-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-ok) 16%,transparent)}',
      '.sa2-h1{margin-top:14px;font:600 28px/38px var(--sa2-sans);letter-spacing:-.015em;text-wrap:balance}',
      '.sa2-h1 b{font-weight:600}',
      '.sa2-h1 .n{color:var(--sa2-wait)}',
      '.sa2-h1 .rest{color:var(--sa2-ink2);font-weight:500}',
      '.sa2-banner{margin-top:14px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--sa2-stuck) 40%,var(--sa2-line));border-radius:10px;background:color-mix(in srgb,var(--sa2-stuck) 7%,var(--sa2-card));font-size:12px;color:var(--sa2-stuck)}',
      // 两层随手记输入卡：首行全宽输入，底栏选目录 / 自动排队切换 / 记下主按钮
      '.sa2-say{margin-top:20px;padding:10px 12px 10px 14px;border:1px solid var(--sa2-line2);border-radius:14px;background:var(--sa2-card);box-shadow:0 2px 12px rgba(0,0,0,.04);display:flex;flex-direction:column;gap:8px;transition:border-color .16s var(--sa2-ease),box-shadow .16s var(--sa2-ease)}',
      '.sa2-say:focus-within{border-color:var(--sa2-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-ink) 10%,transparent)}',
      '.sa2-say input{width:100%;min-width:0;border:0;outline:0;background:none;height:34px;font-size:15px}',
      '.sa2-say input::placeholder{color:var(--sa2-ink3)}',
      '.sa2-say-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--sa2-line)}',
      '.sa2-say-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.sa2 .sa2-chip,.sa2 .sa2-mode-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-sub);font-size:12px;line-height:18px;color:var(--sa2-ink2);white-space:nowrap;max-width:210px;transition:background .16s,border-color .16s}',
      '.sa2-chip b{font-weight:500;overflow:hidden;text-overflow:ellipsis}',
      '.sa2 .sa2-chip:hover,.sa2 .sa2-mode-chip:hover{background:var(--sa2-hover);border-color:var(--sa2-ink3)}',
      '.sa2 .sa2-mode-chip.is-auto{background:color-mix(in srgb,var(--sa2-ok) 12%,var(--sa2-card));border-color:color-mix(in srgb,var(--sa2-ok) 45%,var(--sa2-line2));color:var(--sa2-ok)}',
      '.sa2 .sa2-send{flex:none;height:32px;padding:0 18px;border-radius:999px;background:var(--sa2-ink);color:var(--sa2-bg);font-size:13px;font-weight:600;white-space:nowrap}',
      '.sa2-send:hover{opacity:.88}',
      '.sa2-send:disabled{opacity:.42;cursor:default}',
      '.sa2-say-note{margin:10px 4px 0;font-size:12px;color:var(--sa2-stuck)}',
      // 首次使用空态引导卡
      '.sa2-onboarding{margin-top:20px;padding:16px 18px;border:1px dashed var(--sa2-line2);border-radius:14px;background:var(--sa2-card)}',
      '.sa2-ob-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.sa2-ob-head h2{font:600 14px/20px var(--sa2-sans);color:var(--sa2-ink)}',
      '.sa2-ob-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}',
      '.sa2-ob-step{padding:10px 12px;border:1px solid var(--sa2-line);border-radius:10px;background:var(--sa2-sub);font-size:12px;line-height:18px;color:var(--sa2-ink2)}',
      '.sa2-ob-step b{display:block;margin-bottom:3px;font-weight:600;color:var(--sa2-ink)}',
      '.sa2-ob-prompts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
      '.sa2 .sa2-ob-try{display:inline-flex;align-items:center;padding:5px 11px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);font-size:12px;line-height:18px;color:var(--sa2-ink2);text-align:left}',
      '.sa2 .sa2-ob-try:hover{background:var(--sa2-hover);color:var(--sa2-ink);border-color:var(--sa2-ink3)}',
      // 待确认默认收成一条计数入口，放在「等你」后面；展开先看短预览。
      '.sa2-pending{margin-top:24px;border:1px solid var(--sa2-line);border-radius:14px;background:var(--sa2-card);overflow:hidden}',
      '.sa2-pending-head{display:flex;align-items:center;gap:9px;width:100%;padding:11px 14px;text-align:left}',
      '.sa2-pending-head:hover{background:var(--sa2-hover)}',
      '.sa2-pending-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border:1px dashed var(--sa2-ink3);border-radius:50%;font:600 11px/1 var(--sa2-mono);color:var(--sa2-ink3)}',
      '.sa2-pending-name{flex:none;font-weight:600;font-size:13px;line-height:20px;color:var(--sa2-ink)}',
      '.sa2-pending-n{flex:none;font:600 15px/20px var(--sa2-sans);color:var(--sa2-ink);font-variant-numeric:tabular-nums}',
      '.sa2-pending-hint{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--sa2-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sa2-pending-go{flex:none;font-size:12px;color:var(--sa2-ink2);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-pending-body{border-top:1px solid var(--sa2-line)}',
      '.sa2-pending-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;background:var(--sa2-sub);border-bottom:1px solid var(--sa2-line);font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-pending-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;padding:12px 14px;border-bottom:1px solid var(--sa2-line)}',
      '.sa2-pending-row:last-child{border-bottom:0}',
      '.sa2-pending-main{flex:1 1 280px;min-width:0}',
      '.sa2-pending-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:20px;color:var(--sa2-ink);overflow-wrap:anywhere}',
      '.sa2-pending-row.is-full .sa2-pending-text{display:block;-webkit-line-clamp:unset;overflow:visible;white-space:pre-wrap}',
      '.sa2-pending-meta{display:flex;align-items:center;gap:10px;margin-top:4px;font-size:11px;line-height:17px;color:var(--sa2-ink3);min-width:0}',
      '.sa2-pending-meta small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sa2-pending-open{flex:none;font-size:11px}',
      '.sa2-pending-acts{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;flex:none;margin-left:auto}',
      '.sa2-pending-foot{display:flex;justify-content:flex-end;padding:8px 14px;border-top:1px solid var(--sa2-line)}',
      // 五格态势场（单行锁定最多 6 枚签 + +N 胶囊）
      '.sa2-field{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(4,minmax(0,1fr));gap:1px;margin-top:20px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-line);overflow:hidden}',
      '.sa2-zone{position:relative;min-width:0;padding:14px 16px;background:var(--sa2-card);text-align:left;transition:background .16s var(--sa2-ease)}',
      '.sa2-zone:hover{background:color-mix(in srgb,var(--sa2-ink) 4%,var(--sa2-card))}',
      '.sa2-zone.is-wait{background:color-mix(in srgb,var(--sa2-wait) 9%,var(--sa2-card))}',
      '.sa2-zone.is-wait.zero{background:var(--sa2-card)}',
      '.sa2-zone-k{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-zone-k b{font:600 24px/30px var(--sa2-sans);color:var(--sa2-ink);font-variant-numeric:tabular-nums}',
      '.sa2-zone.is-wait b{color:var(--sa2-wait)}',
      '.sa2-zone.is-wait.zero b{color:var(--sa2-ink)}',
      '.sa2-marks{display:flex;flex-wrap:nowrap;align-items:center;gap:4px;margin-top:10px;height:16px;overflow:hidden}',
      '.sa2-mk{width:10px;height:15px;border-radius:3px;background:var(--sa2-ink4);flex:none}',
      '.sa2-mk.run{background:var(--sa2-run)}',
      '.sa2-mk.need{background:var(--sa2-wait)}',
      '.sa2-mk.stuck{background:var(--sa2-stuck)}',
      '.sa2-mk.done{background:var(--sa2-ok)}',
      '.sa2-mk.queue{background:none;border:1.5px solid var(--sa2-ink3)}',
      '.sa2-mk.later{background:var(--sa2-ink4)}',
      '.sa2-mk-more{padding:0 5px;border-radius:999px;background:var(--sa2-sub);font:600 10.5px/15px var(--sa2-mono);color:var(--sa2-ink2);white-space:nowrap;flex:none}',
      '.sa2-peek{display:block;margin-top:10px;font-size:12px;line-height:18px;color:var(--sa2-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 多项目聚焦胶囊 + 搜索框
      '.sa2-filter-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:16px}',
      '.sa2-proj-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.sa2 .sa2-fpill{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border:1px solid var(--sa2-line);border-radius:999px;background:var(--sa2-card);font-size:12px;line-height:18px;color:var(--sa2-ink2);white-space:nowrap}',
      '.sa2 .sa2-fpill small{font:11px/16px var(--sa2-mono);opacity:.72}',
      '.sa2 .sa2-fpill:hover{background:var(--sa2-hover)}',
      '.sa2 .sa2-fpill[aria-pressed="true"]{background:var(--sa2-ink);border-color:var(--sa2-ink);color:var(--sa2-bg)}',
      '.sa2-search{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);min-width:168px;max-width:220px;flex:0 1 200px}',
      '.sa2-search input{width:100%;min-width:0;border:0;outline:0;background:none;font-size:12px;line-height:18px}',
      '.sa2-search input::placeholder{color:var(--sa2-ink3)}',
      '.sa2-mini{position:sticky;top:0;z-index:20;height:0;pointer-events:none}',
      '.sa2-mini.on{pointer-events:auto}',
      '.sa2-tabs{position:absolute;left:-36px;right:-36px;top:0;display:flex;gap:6px;padding:9px 36px;background:color-mix(in srgb,var(--sa2-bg) 92%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--sa2-line);box-shadow:0 10px 24px rgba(0,0,0,.08);opacity:0;transform:translateY(-10px);transition:opacity .2s var(--sa2-ease),transform .2s var(--sa2-ease);overflow-x:auto;scrollbar-width:none}',
      '.sa2-tabs::-webkit-scrollbar{display:none}',
      '.sa2-mini.on .sa2-tabs{opacity:1;transform:none}',
      '.sa2-tab{flex:none;display:flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid var(--sa2-line);border-radius:999px;font-size:13px;line-height:20px;color:var(--sa2-ink2);white-space:nowrap}',
      '.sa2-tab b{font:600 15px/20px var(--sa2-sans);color:var(--sa2-ink)}',
      '.sa2-tab.need b{color:var(--sa2-wait)}',
      '.sa2-tab:hover{background:var(--sa2-hover)}',
      '.sa2-tab[aria-current="true"]{background:var(--sa2-ink);border-color:var(--sa2-ink);color:var(--sa2-bg)}',
      '.sa2-tab[aria-current="true"] b{color:var(--sa2-bg)}',
      '.sa2-sec{margin-top:34px;scroll-margin-top:82px}',
      '.sa2-sec>header{display:flex;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--sa2-line)}',
      '.sa2-sec h2{display:flex;align-items:center;gap:9px;font:600 15px/22px var(--sa2-sans)}',
      '.sa2-count{font:12px/18px var(--sa2-mono);color:var(--sa2-ink3)}',
      '.sa2-hint{margin-left:auto;font-size:12px;color:var(--sa2-ink3);text-align:right}',
      '.sa2-row{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:2px 16px;align-items:center;padding:14px 0;border-bottom:1px solid var(--sa2-line)}',
      '.sa2-row.is-wait{margin:10px 0 0;padding:15px 16px;border:1px solid var(--sa2-line2);border-left:3px solid var(--sa2-wait);border-radius:12px;background:var(--sa2-card);box-shadow:0 2px 10px rgba(0,0,0,.04);align-items:start}',
      '.sa2-row.is-stuck{border-left-color:var(--sa2-stuck);background:color-mix(in srgb,var(--sa2-stuck) 4%,var(--sa2-card))}',
      '.sa2-row .sa2-mk{align-self:start;margin-top:4px}',
      '.sa2-main{min-width:0}',
      '.sa2-title{display:block;max-width:100%;text-align:left;font-weight:500;font-size:14px;line-height:21px;color:var(--sa2-ink);text-wrap:balance}',
      '.sa2-row.is-wait .sa2-title{font-weight:600;font-size:14.5px;line-height:22px}',
      '.sa2-title:hover{text-decoration:underline;text-underline-offset:3px}',
      '.sa2-why{margin-top:4px;font-size:13px;line-height:20px;color:var(--sa2-ink2);max-width:62ch}',
      '.sa2-proof-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}',
      '.sa2-proof-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border:1px solid color-mix(in srgb,var(--sa2-ok) 35%,var(--sa2-line));border-radius:999px;background:color-mix(in srgb,var(--sa2-ok) 10%,var(--sa2-card));font-size:11px;line-height:17px;color:var(--sa2-ok);font-weight:500}',
      '.sa2-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;font-size:12px;line-height:18px;color:var(--sa2-ink3)}',
      '.sa2-meta .sep{color:var(--sa2-ink4)}',
      '.sa2-ws{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border:1px solid var(--sa2-line);border-radius:999px;font-size:11px;line-height:17px;color:var(--sa2-ink3);max-width:190px}',
      '.sa2-ws:hover{background:var(--sa2-hover);color:var(--sa2-ink2)}',
      '.sa2-ws b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sa2-nows{margin-top:5px;font-size:12px;line-height:18px;color:var(--sa2-ink3)}',
      '.sa2-link{border-bottom:1px solid var(--sa2-line2);color:var(--sa2-ink2)}',
      '.sa2-link:hover{color:var(--sa2-ink)}',
      '.sa2-acts{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0}',
      '.sa2 .sa2-btn{flex:none;height:30px;padding:0 14px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);color:var(--sa2-ink2);font-size:13px;line-height:28px;white-space:nowrap;transition:background .16s,opacity .16s}',
      '.sa2-btn:hover{background:var(--sa2-hover)}',
      '.sa2-btn.pri{background:var(--sa2-ink);border-color:transparent;color:var(--sa2-bg)}',
      '.sa2-btn.pri:hover{opacity:.86;background:var(--sa2-ink)}',
      '.sa2 .sa2-btn.small{height:26px;padding:0 11px;font-size:12px;line-height:24px}',
      '.sa2-btn:disabled{opacity:.45;cursor:default}',
      '.sa2 .sa2-cli-btn,.sa2 .sa2-cli-link{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-sub);font-size:11.5px;line-height:18px;color:var(--sa2-ink2);white-space:nowrap}',
      '.sa2 .sa2-cli-btn:hover,.sa2 .sa2-cli-link:hover{background:var(--sa2-hover);color:var(--sa2-ink);border-color:var(--sa2-ink3)}',
      // 全宽两行内联表单：彻底消灭 28px 挤压输入框 Bug
      '.sa2-form{grid-column:2/-1;display:flex;flex-direction:column;gap:9px;margin-top:12px;padding:12px;border:1px solid var(--sa2-line2);border-radius:10px;background:var(--sa2-sub);min-width:0;width:100%}',
      '.sa2-form input:not([type="checkbox"]){width:100%;min-width:0;height:36px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:8px;background:var(--sa2-card);outline:0;font-size:13px}',
      '.sa2-form input:not([type="checkbox"]):focus{border-color:var(--sa2-ink)}',
      '.sa2-form-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.sa2-form-btns{display:flex;align-items:center;gap:8px;margin-left:auto}',
      '.sa2-form .sa2-checkline{margin-top:0;flex:1 1 220px;min-width:0;font-size:12px}',
      '.sa2-err{grid-column:2/-1;margin-top:6px;font-size:12px;line-height:18px;color:var(--sa2-stuck)}',
      '.sa2-empty{padding:20px 0 24px;color:var(--sa2-ink3);font-size:13px}',
      '.sa2-more{margin-top:14px;font-size:12px;color:var(--sa2-ink3);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-loading{padding:70px 0;color:var(--sa2-ink3);font-size:13px}',
      '.sa2-error{margin-top:40px;padding:22px 24px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-card)}',
      '.sa2-error h2{font:600 18px/26px var(--sa2-sans)}',
      '.sa2-error p{margin-top:8px;font-size:13px;color:var(--sa2-ink2);word-break:break-word}',
      // 抽屉采用三段吸底结构：header + 滚动正文 + sticky 拍板底栏
      '.sa2-scrim{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:rgba(0,0,0,.32)}',
      '.sa2-sheet{width:min(520px,100%);height:100%;display:flex;flex-direction:column;background:var(--sa2-bg);border-left:1px solid var(--sa2-line);animation:sa2slide .28s var(--sa2-ease)}',
      '@keyframes sa2slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}',
      '.sa2-drw-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 24px 12px;border-bottom:1px solid var(--sa2-line);background:var(--sa2-bg)}',
      '.sa2-drw-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2 .sa2-drw-id{font:11px/17px var(--sa2-mono);padding:1px 7px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);color:var(--sa2-ink2)}',
      '.sa2 .sa2-drw-id:hover{background:var(--sa2-hover);color:var(--sa2-ink)}',
      '.sa2-drw-body{flex:1;overflow:auto;padding:18px 24px 28px}',
      '.sa2-drw-foot{flex:none;padding:12px 24px 16px;border-top:1px solid var(--sa2-line);background:var(--sa2-card);box-shadow:0 -6px 20px rgba(0,0,0,.05)}',
      '.sa2-drw-foot-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sa2-drw-foot-tip{margin-left:auto;font-size:11.5px;color:var(--sa2-ink3)}',
      '.sa2-sheet .x{flex:none;font-size:12px;color:var(--sa2-ink3);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-sheet h2{font:600 19px/27px var(--sa2-sans);margin-top:4px;text-wrap:balance}',
      '.sa2-sheet h3{margin:20px 0 8px;font:11px/16px var(--sa2-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--sa2-ink3)}',
      '.sa2-drw-sec-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:20px 0 8px}',
      '.sa2-drw-sec-hd h3{margin:0}',
      '.sa2-sheet p{color:var(--sa2-ink2);font-size:13px;line-height:21px;white-space:pre-wrap;word-break:break-word}',
      '.sa2-sheet .sa2-sm{font-size:12px;line-height:18px;color:var(--sa2-ink3)}',
      '.sa2-kv{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-asg{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--sa2-line);border-radius:10px;background:var(--sa2-card);margin-top:6px;font-size:13px}',
      '.sa2-mono{font-family:var(--sa2-mono);font-size:12px}',
      '.sa2-asg .st{font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-report{margin-top:8px;padding:12px 14px;border:1px solid var(--sa2-line);border-radius:10px;background:var(--sa2-card)}',
      '.sa2-report-h{display:flex;align-items:baseline;gap:10px;font-size:13px}',
      '.sa2-report-h b{font-weight:600}.sa2-report-h span{margin-left:auto;font:11px/18px var(--sa2-mono);color:var(--sa2-ink4)}',
      '.sa2-check{display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:13px;color:var(--sa2-ink2)}',
      '.sa2-check i{flex:none;width:15px;height:15px;margin-top:3px;border:1px solid var(--sa2-line2);border-radius:4px;font:11px/13px var(--sa2-sans);text-align:center;color:var(--sa2-ok)}',
      '.sa2-check code,.sa2-ev-code{font:11px/16px var(--sa2-mono);color:var(--sa2-ink2);border:1px solid var(--sa2-line2);background:var(--sa2-sub);border-radius:5px;padding:0 5px;margin-left:6px;cursor:pointer}',
      '.sa2-check code:hover,.sa2-ev-code:hover{border-color:var(--sa2-ink3);color:var(--sa2-ink)}',
      '.sa2-comment{display:flex;gap:8px;margin-top:16px}',
      '.sa2-comment input{flex:1;min-width:0;height:34px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);outline:0}',
      '.sa2-pop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.32)}',
      '.sa2-popcard{width:min(490px,100%);max-height:84vh;overflow:auto;padding:20px 22px 18px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-card);box-shadow:0 18px 60px rgba(0,0,0,.24)}',
      '.sa2-popcard h3{font:600 16px/24px var(--sa2-sans)}',
      '.sa2-popcard .lead{margin-top:4px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-mdl-tabs{display:flex;gap:4px;margin:10px 0 12px;padding:3px;border:1px solid var(--sa2-line);border-radius:10px;background:var(--sa2-sub)}',
      '.sa2 .sa2-mdl-tab{flex:1;height:28px;padding:0 10px;border-radius:7px;font-size:12.5px;line-height:28px;color:var(--sa2-ink2);text-align:center;white-space:nowrap}',
      '.sa2 .sa2-mdl-tab[aria-selected="true"]{background:var(--sa2-card);color:var(--sa2-ink);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
      '.sa2-autosave-tag{font-size:11.5px;color:var(--sa2-ok);margin-left:6px}',
      '.sa2-pick{display:flex;align-items:center;gap:10px;width:100%;margin-top:8px;padding:9px 11px;border:1px solid var(--sa2-line);border-radius:10px;text-align:left}',
      '.sa2-pick:hover{background:var(--sa2-hover)}',
      '.sa2-pick b{font-weight:500;font-size:13px}',
      '.sa2-pick .p{min-width:0;flex:1}.sa2-pick .p span{display:block;font:11px/17px var(--sa2-mono);color:var(--sa2-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sa2-pick small{font-size:11px;color:var(--sa2-ink3);white-space:nowrap}',
      '.sa2-pop-other{display:flex;gap:8px;margin-top:12px}',
      '.sa2-pop-other input{flex:1;min-width:0;height:32px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-bg);outline:0}',
      '.sa2-pop-foot{display:flex;align-items:center;gap:10px;margin-top:14px}',
      '.sa2-pop-foot .grow{flex:1}',
      '.sa2-router{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:12px;line-height:18px;color:var(--sa2-ink3)}',
      '.sa2-router .sa2-link{font-size:12px}',
      '.sa2-modes,.sa2-limits{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.sa2-opt{height:32px;padding:0 14px;border:1px solid var(--sa2-line2);border-radius:999px;font-size:13px;line-height:30px;color:var(--sa2-ink2);background:var(--sa2-card)}',
      '.sa2-opt:hover{background:var(--sa2-hover)}',
      '.sa2-opt[aria-pressed="true"]{background:var(--sa2-ink);border-color:var(--sa2-ink);color:var(--sa2-bg)}',
      '.sa2-limits .sa2-opt{min-width:44px;text-align:center}',
      '.sa2-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
      '.sa2-badge{flex:none;padding:0 7px;border:1px solid var(--sa2-line);border-radius:999px;font:11px/17px var(--sa2-mono);color:var(--sa2-ink3);background:color-mix(in srgb,var(--sa2-ink) 3%,var(--sa2-card))}',
      '.sa2-badge.is-ext{color:var(--sa2-run);border-color:color-mix(in srgb,var(--sa2-run) 35%,var(--sa2-line));background:color-mix(in srgb,var(--sa2-run) 8%,var(--sa2-card))}',
      '.sa2-split{display:flex;align-items:center;gap:10px;padding:16px 0 4px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-split:before{content:"";flex:1;height:1px;background:var(--sa2-line)}',
      '.sa2-split span{flex:none}',
      '.sa2 .sa2-legacy-btn{flex:none;font-size:11.5px;color:var(--sa2-ink2);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2 .sa2-legacy-btn:hover{color:var(--sa2-ink)}',
      '.sa2-checklist{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:18px;color:var(--sa2-ink2)}',
      '.sa2-checklist li{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}',
      '.sa2-checklist .mark{color:var(--sa2-ink3)}',
      '.sa2-checklist em{font-style:normal;color:var(--sa2-ink3)}',
      '.sa2-checklist code{font:11px/16px var(--sa2-mono);color:var(--sa2-ink2);border:1px solid var(--sa2-line2);background:var(--sa2-sub);border-radius:5px;padding:0 5px}',
      '.sa2-rule{display:flex;align-items:center;gap:8px;margin-top:6px;padding:8px 10px;border:1px solid var(--sa2-line);border-radius:10px;background:var(--sa2-sub);font-size:12px;line-height:18px;color:var(--sa2-ink2)}',
      '.sa2-rule span{flex:1}',
      '.sa2-vents{margin-top:28px;padding-top:14px;border-top:1px solid var(--sa2-line)}',
      '.sa2-rule-list{max-height:280px;overflow:auto;padding-right:4px}',
      '.sa2-code{flex:none;margin-right:7px;font:11px/17px var(--sa2-mono);color:var(--sa2-ink3);letter-spacing:.02em}',
      '.sa2-checkline{display:flex;align-items:center;gap:9px;margin-top:16px;font-size:13px;line-height:20px;color:var(--sa2-ink2);cursor:pointer}',
      '.sa2-checkline input{width:16px;height:16px;margin:0;accent-color:var(--sa2-ink)}',
      '.sa2-toast{position:fixed;left:50%;bottom:28px;z-index:100;transform:translateX(-50%);display:flex;align-items:center;gap:14px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:999px;background:var(--sa2-ink);color:var(--sa2-bg);font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.18);animation:sa2slide .3s var(--sa2-ease)}',
      '.sa2-toast button{flex:none;color:var(--sa2-bg);border-bottom:1px solid color-mix(in srgb,var(--sa2-bg) 50%,transparent);white-space:nowrap}',
      '.sa2-toast span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sa2-chip-x{flex:none;height:24px;padding:0 9px;border-radius:999px;font-size:11.5px;color:var(--sa2-ink2);border:1px solid var(--sa2-line2);background:transparent;white-space:nowrap}',
      '.sa2-chip-x:hover{color:var(--sa2-ink);background:var(--sa2-hover)}',
      '.sa2-qa-trigger{flex:none;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-md,8px);border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;padding:0;margin:0;transition:background-color .14s ease,border-color .14s ease}',
      '.sa2-qa-trigger:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.sa2-qa-trigger:focus-visible{outline:2px solid var(--dsw-alias-link,#4d6bfe);outline-offset:1px}',
      '.sa2-qa-trigger.wide{width:38px;height:38px;border:0.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-button-elevated-fill,rgba(255,255,255,.04));box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.sa2-qa-trigger.wide:hover{background-color:var(--dsw-alias-button-floating-hover,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)))}',
      '.sa2-qa-backdrop{position:fixed;inset:0;z-index:900;background:rgba(15,15,14,.32);display:flex;align-items:flex-start;justify-content:center;padding:min(14vh,120px) 16px 24px;color-scheme:light dark;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif)}',
      '.sa2-qa-card{width:min(460px,100%);background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#141413);border:1px solid var(--dsw-alias-border-l3,rgba(20,20,19,.16));border-radius:16px;padding:18px 20px 16px;box-shadow:0 18px 50px rgba(0,0,0,.24);box-sizing:border-box}',
      '.sa2-qa-card *{box-sizing:border-box}',
      '.sa2-qa-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}',
      '.sa2-qa-head h3{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary,#141413)}',
      '.sa2-qa-close{width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6e6d68);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px}',
      '.sa2-qa-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#141413)}',
      '.sa2-qa-input{width:100%;height:42px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(20,20,19,.18));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#141413);font:14px/20px inherit;outline:none}',
      '.sa2-qa-input:focus{border-color:var(--dsw-alias-link,#4d6bfe)}',
      '.sa2-qa-wsrow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}',
      '.sa2-qa-wslabel{font-size:12px;color:var(--dsw-alias-label-secondary,#6e6d68);margin-right:2px}',
      '.sa2-qa-wsbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:15px;border:1px solid var(--dsw-alias-border-l3,rgba(20,20,19,.18));background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-primary,#141413);font-size:12.5px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sa2-qa-wsbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.sa2-qa-unset{height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(20,20,19,.12));background:transparent;color:var(--dsw-alias-label-secondary,#6e6d68);font-size:12px;cursor:pointer}',
      '.sa2-qa-unset[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#141413);border-color:var(--dsw-alias-label-primary,#141413);font-weight:500}',
      '.sa2-qa-select{height:30px;padding:0 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(20,20,19,.18));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#141413);font-size:12.5px;max-width:220px}',
      '.sa2-qa-err{margin:10px 0 0;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sa2-qa-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.sa2-qa-cancel,.sa2-qa-submit{height:32px;padding:0 14px;border-radius:16px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3,rgba(20,20,19,.18));background:transparent;color:var(--dsw-alias-label-primary,#141413)}',
      '.sa2-qa-submit{background:var(--dsw-alias-label-primary,#141413);border-color:var(--dsw-alias-label-primary,#141413);color:var(--dsw-alias-bg-base,#faf9f5);font-weight:500}',
      '.sa2-qa-submit:disabled{opacity:.42;cursor:default}',
      '@media (prefers-color-scheme:dark){.sa2-qa-card{background:var(--dsw-alias-bg-layer-2,#1f1f23);color:var(--dsw-alias-label-primary,#f3f2ed);border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.16))}.sa2-qa-submit{background:var(--dsw-alias-label-primary,#f3f2ed);border-color:var(--dsw-alias-label-primary,#f3f2ed);color:var(--dsw-alias-bg-base,#141413)}}',
      '@container sa2 (max-width:700px){.sa2-inner{padding:48px 16px 90px}.sa2-tabs{left:-16px;right:-16px;padding:8px 16px}.sa2-h1{font-size:22px;line-height:31px}.sa2-say input{font-size:14px}.sa2-ob-steps{grid-template-columns:1fr}.sa2-search{max-width:100%;flex:1 1 160px}}',
      '@container sa2 (max-width:640px){.sa2-field{grid-template-columns:repeat(5,minmax(0,1fr))}.sa2-zone{padding:10px 4px;text-align:center}.sa2-zone-k{flex-direction:column;align-items:center;gap:0;font-size:11px;line-height:16px}.sa2-zone-k b{font-size:20px;line-height:26px}.sa2-marks,.sa2-peek{display:none}.sa2-hint{display:none}.sa2-sec{margin-top:30px}.sa2-row.is-wait{padding:12px}}',
      '@container sa2 (max-width:560px){.sa2-pending-head{flex-wrap:wrap}.sa2-pending-hint{flex-basis:100%;order:3;white-space:normal}.sa2-pending-go{order:2;margin-left:auto}.sa2-pending-main{flex-basis:100%}.sa2-pending-acts{width:100%;justify-content:flex-start;margin-left:0}.sa2-drw-head,.sa2-drw-body,.sa2-drw-foot{padding-left:16px;padding-right:16px}}',
      '@container sa2 (max-width:460px){.sa2-row{grid-template-columns:18px minmax(0,1fr);align-items:start}.sa2-acts{grid-column:2;justify-content:flex-start;margin-top:8px}.sa2-form{grid-column:1/-1}.sa2-err{grid-column:2}.sa2-asg{grid-template-columns:1fr}.sa2-asg .st{justify-self:start}.sa2 .sa2-send{margin-left:auto}}',
      '@media (max-width:640px){.sa2-sheet{width:100%;border-left:0}.sa2-pop{padding:12px}.sa2-toast{bottom:18px}}',
      '@media (max-width:460px){.sa2-row{grid-template-columns:18px minmax(0,1fr)}.sa2-acts{grid-column:2;justify-content:flex-start;margin-top:8px}.sa2-form{grid-column:1/-1}.sa2-err{grid-column:2}}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      var style = document.getElementById('sa2-panel-style')
      if (!style) {
        style = document.createElement('style')
        style.id = 'sa2-panel-style'
        document.head.appendChild(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
    }

    function wsLabel(path) {
      var text = String(path || '').replace(/\/+$/, '')
      if (!text) return ''
      var parts = text.split('/')
      return parts[parts.length - 1] || text
    }

    function formatAt(iso) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      } catch (error) {
        return ''
      }
    }

    function shortSession(id) {
      var text = String(id || '')
      return text.length > 4 ? '…' + text.slice(-4) : text
    }

    function markOf(stage) {
      if (stage === 'working') return 'run'
      if (stage === 'queued') return 'queue'
      if (stage === 'later') return 'later'
      if (stage === 'closed') return 'done'
      if (stage === 'stuck' || stage === 'silent') return 'stuck'
      return 'need'
    }

    function findCard(view, id) {
      if (!view || !view.groups) return null
      for (var i = 0; i < GROUPS.length; i += 1) {
        var list = view.groups[GROUPS[i]] || []
        for (var j = 0; j < list.length; j += 1) {
          if (list[j].id === id) return list[j]
        }
      }
      return null
    }

    function stateText(value) {
      return ASSIGNMENT[value] || value || '未知'
    }

    function outcomeText(value) {
      return OUTCOME[value] || value || '记录'
    }

    function commentAuthor(author) {
      if (author === 'user') return '你'
      if (author === 'agent') return '它'
      if (author === 'system') return '系统'
      return String(author || '记录')
    }

    function Icon(props) {
      var React = loadReact()
      if (!React) return null
      var size = (props && props.size) || 18
      var active = !!(props && props.active)
      return React.createElement('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
        },
      }, React.createElement('span', {
        style: {
          width: size * 0.46,
          height: size * 0.46,
          borderRadius: 4,
          border: '1.6px solid currentColor',
          background: active ? 'currentColor' : 'transparent',
          boxSizing: 'border-box',
        },
      }))
    }

    function QuickCaptureAction(props) {
      props = props || {}
      var React = loadReact()
      if (!React) return null
      var hh = React.createElement
      var Frag = React.Fragment || 'react.fragment'
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var textState = React.useState('')
      var text = textState[0]
      var setText = textState[1]
      var wsPathState = React.useState(undefined)
      var wsPath = wsPathState[0]
      var setWsPath = wsPathState[1]
      var wsPickerState = React.useState(false)
      var wsPickerOpen = wsPickerState[0]
      var setWsPickerOpen = wsPickerState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errState = React.useState(null)
      var err = errState[0]
      var setErr = errState[1]
      var tickState = React.useState(0)
      var setTick = tickState[1]
      var wsBtnRef = React.useRef(null)

      React.useEffect(function () {
        ensureStyle()
        var bump = function () { setTick(function (v) { return v + 1 }) }
        var unsubWs = hostUi.workspaces && hostUi.workspaces.list && typeof hostUi.workspaces.list.subscribe === 'function'
          ? hostUi.workspaces.list.subscribe(bump)
          : null
        var unsubFactory = subscribeWorkspacePickerFactory(hostUi.slots, bump)
        return function () {
          if (typeof unsubWs === 'function') unsubWs()
          if (typeof unsubFactory === 'function') unsubFactory()
        }
      }, [])

      React.useEffect(function () {
        if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        function onKey(event) {
          if (event && event.key === 'Escape' && !wsPickerOpen) setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [open, wsPickerOpen])

      function openCapture() {
        setErr(null)
        setWsPickerOpen(false)
        setWsPath(function (prev) {
          if (prev !== undefined) return prev
          var fg = activeForegroundWorkspacePath()
          return fg || undefined
        })
        setOpen(true)
      }

      function closeCapture() {
        setWsPickerOpen(false)
        setErr(null)
        setOpen(false)
      }

      function submitCapture(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        var trimmed = String(text || '').trim()
        if (!trimmed || busy) return
        var body = { action: 'create', text: trimmed }
        if (wsPath === null) {
          body.workspacePath = null
          body.workspaceExplicit = true
        } else if (typeof wsPath === 'string' && wsPath) {
          body.workspacePath = wsPath
          body.workspaceExplicit = true
        }
        setBusy(true)
        setErr(null)
        fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            return { ok: res.ok, status: res.status, data: data }
          })
        }).then(function (result) {
          setBusy(false)
          if (result.ok) {
            setText('')
            setWsPickerOpen(false)
            setOpen(false)
            notifyBoardUpdated()
            return
          }
          setErr(String((result.data && result.data.error) || '没有记下来'))
        }).catch(function (error) {
          setBusy(false)
          setErr(String((error && error.message) || error))
        })
      }

      var wide = !!props.wide
      var iconSize = wide ? 14 : 18
      var triggerBtn = hh('button', {
        key: 'sa2-qa-trigger',
        type: 'button',
        className: 'sa2-qa-trigger' + (wide ? ' wide' : ''),
        title: '随手记任务',
        'aria-label': '随手记任务',
        'aria-expanded': open ? 'true' : 'false',
        onClick: function () { if (open) closeCapture(); else openCapture() },
      }, hh('svg', {
        width: iconSize,
        height: iconSize,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        hh('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5 }),
        hh('path', { d: 'M8 5.2v5.6M5.2 8h5.6' }),
      ))

      var usePicker = canUseWorkspacePicker(props)
      var hostWorkspaces = listHostWorkspaceItems()
      var resolvedWsLabel = wsPath === null
        ? '先不定'
        : wsPath
          ? (function () {
              for (var i = 0; i < hostWorkspaces.length; i += 1) {
                if (normalizeDir(hostWorkspaces[i].path) === normalizeDir(wsPath)) return hostWorkspaces[i].label
              }
              return wsLabel(wsPath)
            })()
          : '默认工作区'
      var selectedWsId = typeof wsPath === 'string' && wsPath ? workspaceIdByPath(wsPath) : undefined

      var modalContent = open ? hh('div', {
        key: 'sa2-qa-modal',
        className: 'sa2-qa-backdrop',
        onClick: function (event) {
          if (event && event.target === event.currentTarget && !wsPickerOpen) closeCapture()
        },
      },
        hh('div', {
          className: 'sa2-qa-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '随手记一件事',
        },
          hh('div', { className: 'sa2-qa-head' },
            hh('h3', null, '随手记一件事'),
            hh('button', {
              type: 'button',
              className: 'sa2-qa-close',
              'aria-label': '关闭',
              onClick: closeCapture,
            }, '×'),
          ),
          hh('form', { onSubmit: submitCapture },
            hh('input', {
              autoFocus: true,
              className: 'sa2-qa-input',
              value: text,
              placeholder: '记一件事，回车落板…',
              'aria-label': '任务内容',
              disabled: busy,
              onChange: function (event) {
                setText(event.target.value)
                if (err) setErr(null)
              },
            }),
            hh('div', { className: 'sa2-qa-wsrow' },
              hh('span', { className: 'sa2-qa-wslabel' }, '在哪做'),
              usePicker
                ? hh('button', {
                    ref: wsBtnRef,
                    type: 'button',
                    className: 'sa2-qa-wsbtn',
                    disabled: busy,
                    onClick: function () { setWsPickerOpen(function (v) { return !v }) },
                  }, resolvedWsLabel)
                : hh('select', {
                    className: 'sa2-qa-select',
                    'aria-label': '选择工作区',
                    disabled: busy,
                    value: wsPath === null ? '__none__' : (wsPath || ''),
                    onChange: function (event) {
                      var val = event.target.value
                      setWsPath(val === '__none__' ? null : (val || undefined))
                    },
                  },
                    hh('option', { value: '' }, '默认工作区'),
                    hh('option', { value: '__none__' }, '先不定'),
                    hostWorkspaces.map(function (row) {
                      return hh('option', { key: row.id || row.path, value: row.path }, row.label)
                    }),
                  ),
              usePicker ? props.renderFactorySlot('workspace.picker', {
                open: wsPickerOpen,
                anchorRef: wsBtnRef,
                selectedId: selectedWsId,
                onPick: function (wsId) {
                  var nextPath = pathByWorkspaceId(wsId)
                  if (nextPath) setWsPath(nextPath)
                  setWsPickerOpen(false)
                },
                onClose: function () { setWsPickerOpen(false) },
              }) : null,
              hh('button', {
                type: 'button',
                className: 'sa2-qa-unset',
                'aria-pressed': wsPath === null ? 'true' : 'false',
                disabled: busy,
                onClick: function () {
                  setWsPickerOpen(false)
                  setWsPath(null)
                },
              }, '先不定'),
            ),
            err ? hh('p', { className: 'sa2-qa-err', role: 'alert' }, err) : null,
            hh('div', { className: 'sa2-qa-foot' },
              hh('button', {
                type: 'button',
                className: 'sa2-qa-cancel',
                disabled: busy,
                onClick: closeCapture,
              }, '取消'),
              hh('button', {
                type: 'submit',
                className: 'sa2-qa-submit',
                disabled: busy || !String(text || '').trim(),
              }, busy ? '正在记…' : '记下'),
            ),
          ),
        ),
      ) : null

      var ReactDom = open ? loadReactDom() : null
      var modalNode = (modalContent && ReactDom && typeof ReactDom.createPortal === 'function' && typeof document !== 'undefined' && document.body)
        ? ReactDom.createPortal(modalContent, document.body)
        : modalContent

      return hh(Frag, null, props.children || null, triggerBtn, modalNode)
    }

    function Panel(props) {
      props = props || {}
      var React = loadReact()
      if (!React) return null
      var hh = React.createElement

      var state = React.useState({
        view: null,
        loading: true,
        error: null,
        refresh: 0,
        tab: 'waiting',
        scrolled: false,
        expanded: {},
        // 待确认默认收着：真实积压几十条时，首屏先给「等你」让位。
        pendingOpen: false,
        pendingAll: false,
        pendingFull: {},
        composer: '',
        composerWorkspace: undefined,
        composerAuto: true,
        composerError: null,
        filterWs: 'all',
        query: '',
        form: null,
        formText: '',
        rowError: null,
        busy: null,
        picker: null,
        routerOpen: false,
        modalTab: 'router',
        quietDraft: null,
        quietSaved: false,
        rememberReject: false,
        ventsOpen: false,
        drawer: null,
        toast: null,
      })
      var S = state[0]
      var setS = state[1]
      var wsTickState = React.useState(0)
      var setWsTick = wsTickState[1]
      var sectionRefs = React.useRef({})
      var fieldRef = React.useRef(null)
      var pickerAnchorRef = React.useRef(null)
      var nativeTargetRef = React.useRef(null)

      function patch(next) {
        setS(function (prev) {
          var value = typeof next === 'function' ? next(prev) : next
          if (!value || value === prev) return prev
          return Object.assign({}, prev, value)
        })
      }

      function showToast(text, undoId, extra) {
        patch({
          toast: Object.assign({ text: text, undoId: undoId || null }, extra || {}),
        })
      }

      function copyWithFeedback(text, okMessage, failMessage) {
        var value = String(text || '')
        if (!value) return
        var copiedSync = false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            var result = navigator.clipboard.writeText(value)
            if (result && typeof result.then === 'function') {
              result.then(function () {
                showToast(okMessage)
              }).catch(function () {
                showToast(failMessage)
              })
              return
            }
            copiedSync = true
          }
        } catch (error) {
          copiedSync = false
        }
        showToast(copiedSync ? okMessage : failMessage)
      }

      function buildCliBrief(card) {
        if (!card) return ''
        return [
          '请接手看板任务 ' + card.id + '：「' + card.title + '」',
          '工作目录：' + (card.workspacePath || '未定目录（接手后请先确认工作目录）'),
          '完成后请调用 dsh_taskboard MCP 按 checklist -> check(附证据路径) -> report 提交待验收，不要直接标 done。',
        ].join('\n')
      }

      function copyCliBrief(card) {
        var brief = buildCliBrief(card)
        if (!brief) return
        copyWithFeedback(
          brief,
          '已复制外部 CLI 派工指令（可贴给 Codex / Claude / Antigravity）',
          '未能访问剪贴板，卡号：' + card.id,
        )
      }

      function post(body) {
        return fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            return { ok: res.ok, status: res.status, data: data }
          })
        })
      }

      function reloadCardIfOpen(id) {
        if (!S.drawer || S.drawer.id !== id) return
        fetch(CARD_URL + '?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
          .then(function (res) {
            return res.json().catch(function () { return {} }).then(function (data) {
              if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
              return data
            })
          })
          .then(function (data) {
            patch(function (prev) {
              if (!prev.drawer || prev.drawer.id !== id) return {}
              return { drawer: Object.assign({}, prev.drawer, { loading: false, detail: data.card || prev.drawer.detail }) }
            })
          })
          .catch(function () {})
      }

      function closeDrawer() {
        patch(function (prev) {
          var next = { drawer: null }
          if (prev.form && prev.form.inDrawer) {
            next.form = null
            next.formText = ''
            next.rememberReject = false
            next.rowError = null
          }
          return next
        })
      }

      function runAction(id, action, text, extra, fromPicker) {
        var card = findCard(S.view, id)
        if (action === 'start' && card && card.needsWorkspace && !(extra && extra.cwd)) {
          patch({ picker: { target: 'card', id: id, mode: 'start', other: false, path: '', error: null } })
          return Promise.resolve(false)
        }
        var body = { action: action, id: id, version: card ? card.version : undefined }
        if (text !== undefined && text !== null && text !== '') body.text = text
        if (extra) Object.keys(extra).forEach(function (key) { body[key] = extra[key] })
        // 提交中的同一表单要留住；只有非表单动作才收起已打开的表单。
        var activeForm = S.form && S.form.id === id && S.form.action === action ? S.form : null
        patch(activeForm
          ? { busy: id, rowError: null }
          : { busy: id, rowError: null, form: null, formText: '', rememberReject: false })
        return post(body).then(function (result) {
          if (result.ok) {
            patch(function () {
              return {
                view: result.data,
                loading: false,
                error: null,
                busy: null,
                picker: null,
              }
            })
            reloadCardIfOpen(id)
            return true
          }
          if (result.status === 409) {
            patch(function () {
              return { view: result.data, busy: null, toast: { text: '这件事刚被改过，再点一次', undoId: null } }
            })
            return false
          }
          var message = String((result.data && result.data.error) || '动作没有成功')
          if (result.data && result.data.needWorkspace) {
            patch({ busy: null, picker: { target: 'card', id: id, mode: 'start', other: false, path: '', error: null } })
            return false
          }
          patch(function (prev) {
            if (fromPicker && prev.picker && !prev.picker.native) {
              return { busy: null, picker: Object.assign({}, prev.picker, { error: message }) }
            }
            return { busy: null, picker: null, rowError: { id: id, message: message } }
          })
          return false
        }).catch(function (error) {
          var message = String((error && error.message) || error)
          patch(function () { return { busy: null, rowError: { id: id, message: message } } })
          return false
        })
      }

      function openPicker(target, id, mode, anchorEl) {
        var meta = { target: target, id: id || null, mode: mode || 'workspace' }
        if (anchorEl && canUseWorkspacePicker(props)) {
          pickerAnchorRef.current = anchorEl
          nativeTargetRef.current = meta
          patch({ picker: Object.assign({}, meta, { native: true, open: true, other: false, path: '', error: null }) })
          return
        }
        nativeTargetRef.current = null
        patch({ picker: Object.assign({}, meta, { native: false, open: true, other: false, path: '', error: null }) })
      }

      function pick(path, explicitMeta) {
        var picker = explicitMeta || S.picker || nativeTargetRef.current
        if (!picker) return
        nativeTargetRef.current = null
        if (picker.target === 'composer') {
          patch({ composerWorkspace: path, picker: null, composerError: null })
          return
        }
        if (path === null && picker.mode !== 'workspace') {
          patch({ picker: null })
          return
        }
        if (picker.mode === 'workspace') {
          runAction(picker.id, 'workspace', undefined, { workspacePath: path }, true)
          return
        }
        runAction(picker.id, 'start', undefined, { cwd: path }, true)
      }

      function submitOther() {
        var picker = S.picker
        var path = String(picker && picker.path || '').trim()
        if (!path) return
        pick(path)
      }

      function create() {
        var text = String(S.composer || '').trim()
        if (!text) return
        var autoMode = S.composerAuto !== false
        var body = { action: 'create', text: text }
        var selected = S.composerWorkspace
        if (selected === null) {
          body.workspacePath = null
          body.workspaceExplicit = true
        } else if (typeof selected === 'string' && selected) {
          body.workspacePath = selected
          body.workspaceExplicit = true
        } else if (S.view && S.view.defaultWorkspace) {
          body.workspacePath = S.view.defaultWorkspace
        }
        if (!autoMode) body.later = true
        patch({ busy: 'create', composerError: null })
        post(body).then(function (result) {
          if (result.ok) {
            var task = result.data && result.data.result && result.data.result.task
            var path = task && task.workspacePath
            var label = path ? wsLabel(path) : ''
            var msg = !autoMode
              ? '已放到「以后再说」' + (label ? '（' + label + '）' : '')
              : (label ? '记下了，在 ' + label + ' 里做' : '记下了，还没定在哪做')
            patch(function () {
              return {
                view: result.data,
                composer: '',
                busy: null,
                composerError: null,
                toast: {
                  text: msg,
                  undoId: task ? task.id : null,
                },
              }
            })
            return
          }
          patch({
            busy: null,
            composerError: String((result.data && result.data.error) || '没有记下来'),
          })
        }).catch(function (error) {
          patch({ busy: null, composerError: String((error && error.message) || error) })
        })
      }

      function dismissAllPending() {
        patch({ busy: 'pending-all' })
        post({ action: 'pending_dismiss_all' }).then(function (result) {
          if (result.ok) {
            var cleared = (result.data && result.data.result && result.data.result.cleared) || { count: 0, items: [] }
            patch({
              view: result.data,
              busy: null,
              pendingOpen: false,
              toast: cleared.count
                ? { text: '已忽略全部 ' + cleared.count + ' 条待确认', undoPending: cleared.items }
                : { text: '待确认已清空' },
            })
            return
          }
          patch({ busy: null, rowError: { id: 'pending', message: String((result.data && result.data.error) || '清空失败') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: 'pending', message: String((error && error.message) || error) } })
        })
      }

      function archiveAllLegacy() {
        patch({ busy: 'legacy-all' })
        post({ action: 'queued_manual_later' }).then(function (result) {
          if (result.ok) {
            var moved = (result.data && result.data.result && result.data.result.moved) || { count: 0, ids: [] }
            patch({
              view: result.data,
              busy: null,
              toast: moved.count
                ? { text: '已把 ' + moved.count + ' 张历史手动卡收进「以后再说」', undoRestoreIds: moved.ids }
                : { text: '没有需要收起的历史手动卡' },
            })
            return
          }
          patch({ busy: null, rowError: { id: 'router', message: String((result.data && result.data.error) || '没有收起成功') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: 'router', message: String((error && error.message) || error) } })
        })
      }

      function pendingAccept(id) {
        patch({ busy: id })
        post({ action: 'pending_accept', id: id }).then(function (result) {
          if (result.ok) {
            var task = result.data && result.data.result && result.data.result.task
            patch(function () {
              return {
                view: result.data,
                busy: null,
                toast: { text: '已记到板上', undoId: task ? task.id : null },
              }
            })
            return
          }
          patch({ busy: null, rowError: { id: id, message: String((result.data && result.data.error) || '没有记下来') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: id, message: String((error && error.message) || error) } })
        })
      }

      function pendingDismiss(id) {
        patch({ busy: id })
        post({ action: 'pending_dismiss', id: id }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null })
            return
          }
          patch({ busy: null, rowError: { id: id, message: String((result.data && result.data.error) || '没有丢掉') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: id, message: String((error && error.message) || error) } })
        })
      }

      function pendingAttach(id) {
        patch({ busy: id })
        post({ action: 'pending_attach', id: id }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null, toast: { text: '已补到那张卡上', undoId: null } })
            return
          }
          patch({ busy: null, rowError: { id: id, message: String((result.data && result.data.error) || '没有补上') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: id, message: String((error && error.message) || error) } })
        })
      }

      function sessionShort8(id) {
        var text = String(id || '')
        return text ? '…' + text.slice(-8) : ''
      }

      function openSessionRow(card) {
        var sessionId = String(card.sessionId || '')
        if (hostUi.openSession) {
          try {
            var opened = hostUi.openSession(sessionId)
            if (opened && typeof opened.catch === 'function') opened.catch(function () {})
            return
          } catch (error) {
            // 跳不过去就退回复制。
          }
        }
        copyWithFeedback(sessionId, '会话编号已复制：' + sessionId, '会话编号：' + sessionId)
      }

      function modeWord(mode) {
        return mode === 'auto' ? '自动中' : mode === 'off' ? '自动开工已关' : '观察中'
      }

      function modeHint(router) {
        return router.mode === 'auto'
          ? '有空位就开工'
          : router.mode === 'off'
            ? '自动开工已关'
            : '观察中，只记不动手'
      }

      function modeToggle(router) {
        return router.mode === 'auto' ? '切到观察' : router.mode === 'off' ? '打开' : '切到自动'
      }

      function routerSet(action, text) {
        patch({ busy: 'router', rowError: null })
        post({ action: action, text: String(text) }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null, routerOpen: false })
            return
          }
          patch({ busy: null, rowError: { id: 'router', message: String((result.data && result.data.error) || '没有改成功') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: 'router', message: String((error && error.message) || error) } })
        })
      }

      function notifySet(action, text) {
        patch({ busy: 'notify', rowError: null, quietSaved: false })
        post({ action: action, text: String(text) }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null, quietDraft: null, quietSaved: action === 'notify_quiet' })
            return
          }
          patch({ busy: null, rowError: { id: 'notify', message: String((result.data && result.data.error) || '没有改成功') } })
        }).catch(function (error) {
          patch({ busy: null, rowError: { id: 'notify', message: String((error && error.message) || error) } })
        })
      }

      function refreshWith(body) {
        var area = String(body.action || '').indexOf('rule_') === 0 ? 'rules' : 'vents'
        post(body).then(function (result) {
          if (result.ok) patch({ view: result.data, rowError: null })
          else patch({ rowError: { id: area, message: String((result.data && result.data.error) || '没有改成功') } })
        }).catch(function (error) {
          patch({ rowError: { id: area, message: String((error && error.message) || error) } })
        })
      }

      function evidenceChips(files) {
        return (Array.isArray(files) ? files : []).map(function (file) {
          var text = String(file)
          return hh('code', {
            key: text,
            className: 'sa2-ev-code',
            title: text,
            onClick: function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              copyWithFeedback(text, '已复制证据路径：' + text, '证据路径：' + text)
            },
          }, text.split('/').pop() || text)
        })
      }

      function renderVents() {
        var vents = (S.view && S.view.vents) || { count: 0, items: [] }
        if (!vents.count) return null
        return hh('div', { className: 'sa2-vents' },
          hh('button', {
            type: 'button', className: 'sa2-link',
            onClick: function () { patch({ ventsOpen: !S.ventsOpen }) },
          }, 'AGENT 吐槽 ' + vents.count + ' 条 ' + (S.ventsOpen ? '收起' : '展开')),
          S.ventsOpen
            ? hh('div', { className: 'sa2-rule-list' }, vents.items.map(function (vent) {
                return hh('div', { className: 'sa2-rule', key: vent.id },
                  hh('span', null, vent.text),
                  hh('button', { type: 'button', className: 'sa2-link', onClick: function () { refreshWith({ action: 'vent_card', text: vent.id }) } }, '记成一件事'),
                  hh('button', { type: 'button', className: 'sa2-link', onClick: function () { refreshWith({ action: 'vent_dismiss', text: vent.id }) } }, '知道了'),
                )
              }))
            : null,
          S.rowError && S.rowError.id === 'vents'
            ? hh('p', { className: 'sa2-err' }, S.rowError.message)
            : null,
        )
      }

      function undo() {
        var toast = S.toast
        if (!toast) {
          patch({ toast: null })
          return
        }
        var body = null
        if (toast.undoPending && toast.undoPending.length) {
          body = { action: 'pending_restore', items: toast.undoPending }
        } else if (toast.undoRestoreIds && toast.undoRestoreIds.length) {
          body = { action: 'queued_manual_restore', ids: toast.undoRestoreIds }
        } else if (toast.undoId) {
          body = { action: 'cancel', id: toast.undoId }
        }
        if (!body) {
          patch({ toast: null })
          return
        }
        post(body).then(function (result) {
          if (result.ok) patch({ view: result.data, toast: null })
          else patch({ toast: null })
        }).catch(function () { patch({ toast: null }) })
      }

      function openCard(id) {
        patch({ drawer: { id: id, loading: true, detail: null, error: null, comment: '' } })
        fetch(CARD_URL + '?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
          .then(function (res) {
            return res.json().catch(function () { return {} }).then(function (data) {
              if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
              return data
            })
          })
          .then(function (data) {
            patch(function (prev) {
              if (!prev.drawer || prev.drawer.id !== id) return {}
              return { drawer: Object.assign({}, prev.drawer, { loading: false, detail: data.card || null }) }
            })
          })
          .catch(function (error) {
            patch(function (prev) {
              if (!prev.drawer || prev.drawer.id !== id) return {}
              return { drawer: Object.assign({}, prev.drawer, { loading: false, error: String((error && error.message) || error) }) }
            })
          })
      }

      function submitComment() {
        var drawer = S.drawer
        var text = String(drawer && drawer.comment || '').trim()
        if (!drawer || !text) return
        patch({ busy: drawer.id })
        post({ action: 'comment', id: drawer.id, text: text }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null })
            openCard(drawer.id)
            return
          }
          patch({ busy: null, drawer: Object.assign({}, drawer, { error: String((result.data && result.data.error) || '没有送出去') }) })
        }).catch(function (error) {
          patch({ busy: null, drawer: Object.assign({}, drawer, { error: String((error && error.message) || error) }) })
        })
      }

      function submitForm() {
        var form = S.form
        if (!form) return
        var text = String(S.formText || '').trim()
        var card = findCard(S.view, form.id)
        if (!text && form.action !== 'comment') {
          patch({ rowError: { id: form.id, message: form.action === 'reject' ? '写一句打回的原因，它才知道改什么' : '先写一句再送出' } })
          return
        }
        if (form.action === 'comment' && !text) {
          patch({ rowError: { id: form.id, message: '先写一句再送出' } })
          return
        }
        var extra = form.action === 'reject' && S.rememberReject ? { remember: true } : undefined
        var submitted = form
        runAction(form.id, form.action, text, extra).then(function (ok) {
          if (ok) {
            patch(function (prev) {
              // 回调里的 S 是旧 render 闭包；按当前状态比较，旧请求不能抹另一个表单。
              return prev.form === submitted
                ? { form: null, formText: '', rememberReject: false, rowError: null }
                : {}
            })
          }
        })
      }

      function openForm(card, definition, inDrawer) {
        patch({
          form: {
            id: card.id,
            action: definition.action,
            label: definition.label,
            inDrawer: !!inDrawer,
          },
          formText: definition.preset || '',
          rememberReject: false,
          rowError: null,
        })
      }

      function doAction(card, definition, anchorEl, inDrawer) {
        if (definition.needsText) {
          openForm(card, definition, inDrawer)
          return
        }
        if (definition.action === 'start' && card.needsWorkspace) {
          openPicker('card', card.id, 'start', anchorEl)
          return
        }
        if (definition.action === 'answer') {
          runAction(card.id, 'answer', definition.preset || '')
          return
        }
        runAction(card.id, definition.action)
      }

      function scrollToGroup(key) {
        patch({ tab: key })
        var el = typeof document !== 'undefined' ? document.getElementById('sa2-sec-' + key) : null
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }

      React.useEffect(function () {
        ensureStyle()
        var alive = true
        var inFlight = false
        function load() {
          if (inFlight) return
          inFlight = true
          fetch(VIEW_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then(function (res) {
              return res.json().catch(function () { return {} }).then(function (data) {
                if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
                return data
              })
            })
            .then(function (data) {
              if (!alive) return
              patch(function (prev) {
                return { loading: false, view: data, error: null, refresh: prev.refresh }
              })
            })
            .catch(function (error) {
              if (!alive) return
              patch({ loading: false, error: String((error && error.message) || error) })
            })
            .then(function () { inFlight = false })
        }
        load()
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, 5000)
        function onVisible() {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') load()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return function () {
          alive = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [S.refresh])

      React.useEffect(function () {
        var onBoard = function () { patch(function (prev) { return { refresh: prev.refresh + 1 } }) }
        var onWs = function () { setWsTick(function (v) { return v + 1 }) }
        boardListeners.add(onBoard)
        var unsubWs = hostUi.workspaces && hostUi.workspaces.list && typeof hostUi.workspaces.list.subscribe === 'function'
          ? hostUi.workspaces.list.subscribe(onWs)
          : null
        var unsubFactory = subscribeWorkspacePickerFactory(hostUi.slots, onWs)
        return function () {
          boardListeners.delete(onBoard)
          if (typeof unsubWs === 'function') unsubWs()
          if (typeof unsubFactory === 'function') unsubFactory()
        }
      }, [])

      React.useEffect(function () {
        var raf = 0
        function measure() {
          var field = fieldRef.current
          var scrolled = field ? field.getBoundingClientRect().bottom < 8 : false
          var line = 92
          var current = 'waiting'
          for (var i = 0; i < GROUPS.length; i += 1) {
            var el = sectionRefs.current[GROUPS[i]]
            if (el && el.getBoundingClientRect().top <= line) current = GROUPS[i]
          }
          patch(function (prev) {
            if (prev.scrolled === scrolled && prev.tab === current) return {}
            return { scrolled: scrolled, tab: current }
          })
        }
        function onScroll() {
          if (raf) return
          raf = requestAnimationFrame(function () {
            raf = 0
            measure()
          })
        }
        window.addEventListener('scroll', onScroll, true)
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        var start = setTimeout(measure, 40)
        return function () {
          clearTimeout(start)
          if (raf) cancelAnimationFrame(raf)
          window.removeEventListener('scroll', onScroll, true)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [])

      React.useEffect(function () {
        if (!S.toast) return undefined
        var timer = setTimeout(function () {
          patch({ toast: null })
        }, 6000)
        return function () { clearTimeout(timer) }
      }, [S.toast])

      React.useEffect(function () {
        function onKey(event) {
          if (event.key !== 'Escape') return
          if (S.drawer) {
            closeDrawer()
            return
          }
          if (S.picker) {
            patch({ picker: null })
            return
          }
          if (S.routerOpen) {
            patch({ routerOpen: false })
            return
          }
          if (S.form) {
            patch({ form: null, formText: '' })
          }
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      })

      function renderMark(kind, extraClass) {
        return hh('span', { className: 'sa2-mk ' + kind + (extraClass ? ' ' + extraClass : '') })
      }

      function renderAction(card, definition, index, inDrawer) {
        var key = (definition.action || 'a') + '-' + index + '-' + String(definition.label || '')
        return hh('button', {
          key: key,
          type: 'button',
          className: 'sa2-btn' + (definition.primary ? ' pri' : ''),
          disabled: S.busy === card.id,
          onClick: function (event) { doAction(card, definition, event && event.currentTarget, inDrawer) },
        }, definition.label)
      }

      function renderForm(card, inDrawer) {
        if (!S.form || S.form.id !== card.id) return null
        if (Boolean(S.form.inDrawer) !== Boolean(inDrawer)) return null
        var form = S.form
        var placeholder = form.action === 'reject'
          ? '哪里不对？一句话就行'
          : form.action === 'answer'
            ? '写下你的回答'
            : '告诉它接下来怎么做'
        return hh('div', { className: 'sa2-form' },
          hh('input', {
            value: S.formText,
            autoFocus: true,
            placeholder: placeholder,
            onChange: function (event) { patch({ formText: event.target.value }) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitForm()
              }
              if (event.key === 'Escape') patch({ form: null, formText: '', rememberReject: false })
            },
          }),
          hh('div', { className: 'sa2-form-foot' },
            form.action === 'reject' && card.workspacePath
              ? hh('label', { className: 'sa2-checkline' },
                  hh('input', {
                    type: 'checkbox', checked: S.rememberReject,
                    onChange: function (event) { patch({ rememberReject: event.target.checked }) },
                  }),
                  hh('span', null, '以后这个项目都按这条查'),
                )
              : null,
            hh('div', { className: 'sa2-form-btns' },
              hh('button', {
                type: 'button',
                className: 'sa2-btn pri',
                disabled: S.busy === card.id,
                onClick: submitForm,
              }, form.label || '送出'),
              hh('button', {
                type: 'button',
                className: 'sa2-btn',
                onClick: function () { patch({ form: null, formText: '', rememberReject: false }) },
              }, '取消'),
            ),
          ),
        )
      }

      function renderRow(card, badge) {
        var isWait = WAITING_STAGES.indexOf(card.stage) >= 0
        var meta = []
        if (card.who) meta.push(hh('span', { key: 'who' }, card.who))
        if (card.workspacePath) {
          meta.push(hh('button', {
            key: 'ws',
            type: 'button',
            className: 'sa2-ws',
            title: card.workspacePath,
            onClick: function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              openPicker('card', card.id, 'workspace', event && event.currentTarget)
            },
          }, '在 ', hh('b', {}, card.workspaceLabel || wsLabel(card.workspacePath))))
        }
        var hasChecklist = Array.isArray(card.checklist) && card.checklist.length > 0
        var checkedCount = hasChecklist
          ? card.checklist.filter(function (item) { return !!item.checked }).length
          : 0
        return hh('li', {
          key: card.id,
          className: 'sa2-row' + (isWait ? ' is-wait' : '') + (card.stage === 'stuck' ? ' is-stuck' : ''),
        },
          renderMark(markOf(card.stage)),
          hh('div', { className: 'sa2-main' },
            hh('div', { className: 'sa2-head' },
              hh('button', {
                type: 'button',
                className: 'sa2-title',
                onClick: function () { openCard(card.id) },
              },
                card.code ? hh('span', { className: 'sa2-code' }, card.code) : null,
                card.title,
              ),
              badge ? hh('span', { className: 'sa2-badge' }, badge) : null,
              card.lastReportBy === 'mcp' ? hh('span', { className: 'sa2-badge is-ext' }, '外部 Agent 交的') : null,
              card.rejectCount ? hh('span', { className: 'sa2-badge' }, '打回过 ' + card.rejectCount + ' 次') : null,
            ),
            card.reason ? hh('p', { className: 'sa2-why' }, card.reason) : null,
            hasChecklist
              ? hh('div', { className: 'sa2-proof-bar' },
                  hh('span', { className: 'sa2-proof-pill' }, '✓ 验收单 ' + checkedCount + '/' + card.checklist.length),
                )
              : null,
            hasChecklist
              ? hh('ul', { className: 'sa2-checklist' }, card.checklist.map(function (item) {
                  return hh('li', { key: item.id },
                    hh('span', { className: 'mark' }, item.checked ? '✓' : '○'),
                    hh('span', null, item.text),
                    item.note ? hh('em', null, item.note) : null,
                    evidenceChips(item.evidence),
                  )
                }))
              : null,
            meta.length ? hh('p', { className: 'sa2-meta' }, meta) : null,
            card.needsWorkspace ? hh('p', { className: 'sa2-nows' },
              '还没定在哪做 ',
              hh('button', {
                type: 'button',
                className: 'sa2-link',
                onClick: function (event) { openPicker('card', card.id, 'workspace', event && event.currentTarget) },
              }, '选目录'),
            ) : null,
            renderForm(card, false),
            S.rowError && S.rowError.id === card.id
              ? hh('p', { className: 'sa2-err' }, S.rowError.message)
              : null,
          ),
          hh('div', { className: 'sa2-acts' },
            card.group === 'running' && card.sessionId
              ? hh('button', {
                  key: 'session',
                  type: 'button',
                  className: 'sa2-btn',
                  title: card.sessionId,
                  onClick: function () { openSessionRow(card) },
                }, hostUi.canOpen ? '打开会话' : sessionShort8(card.sessionId))
              : null,
            (card.actions || []).map(function (definition, index) {
              return renderAction(card, definition, index)
            }),
            (card.group === 'waiting' || card.group === 'queued')
              ? hh('button', {
                  key: 'cli',
                  type: 'button',
                  className: 'sa2-cli-link',
                  title: '复制这条任务的外部 CLI 派工指令（DSH MCP 验收闭环）',
                  onClick: function (event) {
                    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                    copyCliBrief(card)
                  },
                }, '复制给 CLI')
              : null,
          ),
        )
      }

      // 排队组里自动排队的行带「第 N 个」；第一张老卡前加一条分隔线和数量。
      function renderQueuedRows(rows, manualCount) {
        var out = []
        var split = false
        rows.forEach(function (card) {
          if (!card.auto && !split) {
            split = true
            out.push(hh('li', { key: 'split', className: 'sa2-split' },
              hh('span', null, '下面 ' + manualCount + ' 张老卡 · 要你点开始'),
              manualCount > 0
                ? hh('button', {
                    type: 'button',
                    className: 'sa2-legacy-btn',
                    disabled: S.busy === 'legacy-all',
                    onClick: archiveAllLegacy,
                  }, S.busy === 'legacy-all' ? '收起中…' : '收进以后再说')
                : null))
          }
          var badge = card.auto
            ? card.position ? '第 ' + card.position + ' 个' : '自动排队'
            : null
          out.push(renderRow(card, badge))
        })
        return out
      }

      function filterMatches(card) {
        var ws = S.filterWs || 'all'
        if (ws === '__unset__') {
          if (card.workspacePath) return false
        } else if (ws !== 'all') {
          if (card.workspacePath !== ws) return false
        }
        var q = String(S.query || '').trim().toLowerCase()
        if (!q) return true
        var haystack = [
          card.title,
          card.code,
          card.id,
          card.reason,
          card.workspaceLabel || wsLabel(card.workspacePath),
          card.who,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.indexOf(q) >= 0
      }

      function groupCards(key) {
        var raw = (S.view && S.view.groups && S.view.groups[key]) || []
        var hasFilter = (S.filterWs && S.filterWs !== 'all') || !!String(S.query || '').trim()
        return hasFilter ? raw.filter(filterMatches) : raw
      }

      function renderSection(key) {
        var hasFilter = (S.filterWs && S.filterWs !== 'all') || !!String(S.query || '').trim()
        var list = groupCards(key)
        var expanded = !!S.expanded[key]
        var shown = expanded ? list : list.slice(0, 8)
        var more = list.length - shown.length
        var router = S.view && S.view.router
        var isQueued = key === 'queued'
        var manualCount = list.filter(function (card) { return !card.auto }).length
        return hh('section', {
          key: key,
          className: 'sa2-sec',
          id: 'sa2-sec-' + key,
          ref: function (el) { sectionRefs.current[key] = el },
        },
          hh('header', null,
            hh('h2', null, renderMark(markOf(key === 'waiting' ? 'approval' : key === 'running' ? 'working' : key === 'queued' ? 'queued' : key === 'later' ? 'later' : 'closed')), META[key].label),
            hh('span', { className: 'sa2-count' }, String(list.length)),
            hh('span', { className: 'sa2-hint' }, isQueued && router ? modeHint(router) : META[key].hint),
          ),
          isQueued && router
            ? hh('p', { className: 'sa2-router' },
                hh('span', null, '同时最多跑 ' + router.maxRunning + ' 件 · ' + modeWord(router.mode)),
                hh('button', {
                  type: 'button',
                  className: 'sa2-link',
                  onClick: function () { patch({ routerOpen: true, modalTab: 'router', quietSaved: false }) },
                }, modeToggle(router)),
              )
            : null,
          isQueued && S.rowError && S.rowError.id === 'router'
            ? hh('p', { className: 'sa2-err' }, S.rowError.message)
            : null,
          list.length
            ? hh('ul', { className: 'sa2-list' },
                isQueued ? renderQueuedRows(shown, manualCount) : shown.map(renderRow))
            : hh('p', { className: 'sa2-empty' }, hasFilter ? '当前筛选条件下这一组没有匹配的卡片。' : META[key].empty),
          more > 0
            ? hh('button', {
                type: 'button',
                className: 'sa2-more',
                onClick: function () {
                  patch(function (prev) {
                    var next = Object.assign({}, prev.expanded)
                    next[key] = true
                    return { expanded: next }
                  })
                },
              }, '还有 ' + more + ' 件')
            : null,
          expanded && list.length > 8
            ? hh('button', {
                type: 'button',
                className: 'sa2-more',
                onClick: function () {
                  patch(function (prev) {
                    var next = Object.assign({}, prev.expanded)
                    next[key] = false
                    return { expanded: next }
                  })
                },
              }, '收起')
            : null,
        )
      }

      function renderPeek(key, list) {
        if (!list.length) return META[key].empty
        var top = list[0]
        var label = top.workspaceLabel || wsLabel(top.workspacePath)
        var text = label ? label + ' · ' + top.title : top.title
        if (list.length > 1) text += ' 等 ' + list.length + ' 件'
        return text
      }

      function renderZone(key) {
        var MAX_MK = 6
        var list = (S.view && S.view.groups && S.view.groups[key]) || []
        var marks = list.slice(0, MAX_MK).map(function (card, index) {
          return hh('span', { key: card.id + '-' + index, className: 'sa2-mk ' + markOf(card.stage) })
        })
        if (list.length > MAX_MK) marks.push(hh('span', { key: 'more', className: 'sa2-mk-more' }, '+' + (list.length - MAX_MK)))
        var peek = renderPeek(key, list)
        return hh('button', {
          key: key,
          type: 'button',
          className: 'sa2-zone' + (key === 'waiting' ? ' is-wait' : '') + (list.length ? '' : ' zero'),
          onClick: function () { scrollToGroup(key) },
          'aria-label': META[key].label + ' ' + list.length + ' 件，跳到这一组',
        },
          hh('span', { className: 'sa2-zone-k' }, hh('b', null, String(list.length)), hh('span', null, META[key].label)),
          hh('span', { className: 'sa2-marks' }, marks),
          hh('span', { className: 'sa2-peek' }, peek),
        )
      }

      function renderTabs() {
        var hasFilter = (S.filterWs && S.filterWs !== 'all') || !!String(S.query || '').trim()
        return hh('div', { className: 'sa2-mini' + (S.scrolled ? ' on' : '') },
          hh('nav', { className: 'sa2-tabs', 'aria-label': '五组，滑到哪亮哪，点哪滑到哪' },
            GROUPS.map(function (key) {
              var count = hasFilter
                ? groupCards(key).length
                : ((S.view && S.view.counts && S.view.counts[key]) || 0)
              return hh('button', {
                key: key,
                type: 'button',
                className: 'sa2-tab' + (key === 'waiting' ? ' need' : ''),
                'aria-current': S.tab === key ? 'true' : 'false',
                onClick: function () { scrollToGroup(key) },
              }, hh('b', null, String(count)), hh('span', null, META[key].label))
            }),
          ),
        )
      }

      function renderComposer() {
        var usePicker = canUseWorkspacePicker(props)
        var selected = S.composerWorkspace
        var resolvedPath = selected === null
          ? null
          : selected
            ? selected
            : (S.view && S.view.defaultWorkspace) || null
        var label = selected === null
          ? '先不定'
          : selected
            ? wsLabel(selected)
            : S.view && S.view.defaultWorkspace
              ? wsLabel(S.view.defaultWorkspace)
              : '先不定'
        var autoMode = S.composerAuto !== false
        return hh('form', {
          className: 'sa2-say',
          onSubmit: function (event) {
            event.preventDefault()
            create()
          },
        },
          hh('input', {
            value: S.composer,
            placeholder: '想到什么事，说一句，我记下并安排',
            'aria-label': '说一件事，记到板上',
            onChange: function (event) { patch({ composer: event.target.value, composerError: null }) },
          }),
          hh('div', { className: 'sa2-say-bar' },
            hh('div', { className: 'sa2-say-meta' },
              hh('button', {
                type: 'button',
                className: 'sa2-chip',
                onClick: function (event) { openPicker('composer', null, 'workspace', event && event.currentTarget) },
                title: selected || (S.view && S.view.defaultWorkspace) || '先不定',
              }, '在哪做 · ', hh('b', null, label)),
              usePicker && resolvedPath
                ? hh('button', {
                    type: 'button',
                    className: 'sa2-chip-x',
                    title: '改为先不定工作区',
                    'aria-label': '改为先不定工作区',
                    onClick: function () {
                      nativeTargetRef.current = null
                      patch({ composerWorkspace: null, picker: null, composerError: null })
                    },
                  }, '先不定')
                : null,
              hh('button', {
                type: 'button',
                className: 'sa2-mode-chip' + (autoMode ? ' is-auto' : ''),
                'aria-pressed': autoMode ? 'true' : 'false',
                title: autoMode ? '切到手动：记下后先放「以后再说」' : '切回自动：记下后直接排入自动队列',
                onClick: function () { patch({ composerAuto: !autoMode }) },
              }, autoMode ? '⚡ 记下即排入自动队' : '📌 先放以后再说'),
            ),
            hh('button', {
              type: 'submit',
              className: 'sa2-send',
              disabled: S.busy === 'create' || !String(S.composer || '').trim(),
            }, '记下'),
          ),
        )
      }

      // 待确认：默认只留一条计数入口，放在「等你」后面；展开先看短预览，
      // 原文按条再展开。它不是卡，不进五组、不动台账，只把已有的记录画出来。
      function renderPendingRail() {
        var rows = (S.view && S.view.pending) || []
        if (!rows.length) return null
        var open = !!S.pendingOpen
        var shown = open ? (S.pendingAll ? rows : rows.slice(0, 8)) : []
        var more = open ? rows.length - shown.length : 0
        return hh('section', { key: 'pending', className: 'sa2-pending', id: 'sa2-pending' },
          hh('button', {
            type: 'button',
            className: 'sa2-pending-head',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'sa2-pending-list',
            'aria-label': '待确认 ' + rows.length + ' 条，' + (open ? '收起' : '点开看'),
            onClick: function () {
              patch(function (prev) {
                return { pendingOpen: !prev.pendingOpen, pendingAll: false }
              })
            },
          },
            hh('span', { className: 'sa2-pending-mark', 'aria-hidden': 'true' }, '?'),
            hh('span', { className: 'sa2-pending-name' }, '待确认'),
            hh('b', { className: 'sa2-pending-n' }, String(rows.length)),
            hh('span', { className: 'sa2-pending-hint' },
              open ? '先看短的；要原文再展开，记不记由你定' : '它听到但拿不准要不要记，先收在这里，不占屏'),
            hh('span', { className: 'sa2-pending-go' }, open ? '收起' : '点开看'),
          ),
          open
            ? hh('div', { key: 'body', className: 'sa2-pending-body', id: 'sa2-pending-list' },
                rows.length > 1
                  ? hh('div', { className: 'sa2-pending-tools' },
                      hh('span', null, '共 ' + rows.length + ' 条待确认，可逐条处理或一键清空'),
                      hh('button', {
                        type: 'button',
                        className: 'sa2-link',
                        disabled: S.busy === 'pending-all',
                        onClick: dismissAllPending,
                      }, S.busy === 'pending-all' ? '清空中…' : '全部忽略清空'),
                    )
                  : null,
                hh('ul', null, shown.map(function (row) {
                  var full = !!S.pendingFull[row.id]
                  var text = String(row.text || '')
                  // 预览是真截短的字符串，不是靠 CSS 夹住整段；展开前读屏也只读到短的。
                  var flat = text.replace(/\s+/g, ' ').trim()
                  var preview = flat.length > 72 ? flat.slice(0, 72) + '…' : flat
                  var long = preview !== flat || text.indexOf('\n') >= 0
                  var textId = 'sa2-pending-text-' + row.id
                  return hh('li', { key: row.id, className: 'sa2-pending-row' + (full ? ' is-full' : '') },
                    hh('div', { className: 'sa2-pending-main' },
                      hh('p', { className: 'sa2-pending-text', id: textId }, full ? text : preview),
                      hh('p', { className: 'sa2-pending-meta' },
                        hh('small', null,
                          (row.attach && row.suggestedTitle ? '可补到「' + row.suggestedTitle + '」' : (row.workspaceLabel ? '在 ' + row.workspaceLabel : '还没定在哪做'))
                          + ' · ' + (row.ago || '刚刚')),
                        long
                          ? hh('button', {
                              type: 'button',
                              className: 'sa2-link sa2-pending-open',
                              'aria-expanded': full ? 'true' : 'false',
                              'aria-controls': textId,
                              onClick: function () {
                                patch(function (prev) {
                                  var next = Object.assign({}, prev.pendingFull)
                                  if (next[row.id]) delete next[row.id]
                                  else next[row.id] = true
                                  return { pendingFull: next }
                                })
                              },
                            }, full ? '收起原文' : '展开原文')
                          : null,
                      ),
                    ),
                    hh('div', { className: 'sa2-pending-acts' },
                      hh('button', {
                        type: 'button',
                        className: 'sa2-btn pri small',
                        disabled: S.busy === row.id,
                        onClick: function () {
                          if (row.attach) pendingAttach(row.id)
                          else pendingAccept(row.id)
                        },
                      }, row.attach ? '补到那张卡上' : '记下'),
                      hh('button', {
                        type: 'button',
                        className: 'sa2-btn small',
                        disabled: S.busy === row.id,
                        onClick: function () { pendingDismiss(row.id) },
                      }, '不用'),
                    ),
                  )
                })),
                more > 0
                  ? hh('div', { key: 'more', className: 'sa2-pending-foot' },
                      hh('button', {
                        type: 'button',
                        className: 'sa2-more',
                        onClick: function () { patch({ pendingAll: true }) },
                      }, '还有 ' + more + ' 条'),
                    )
                  : null,
              )
            : null,
        )
      }

      function renderRouterPop() {
        if (!S.routerOpen) return null
        var router = (S.view && S.view.router) || { mode: 'observe', maxRunning: 2 }
        var notify = (S.view && S.view.notify) || { mode: 'off', quiet: { from: '23:00', to: '08:00' }, configured: false, status: 'off' }
        var rules = (S.view && S.view.acceptanceRules) || { count: 0, items: [] }
        var vents = (S.view && S.view.vents) || { count: 0, items: [] }
        var tab = S.modalTab || 'router'
        var quiet = S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }
        var modes = [
          { mode: 'off', label: '关' },
          { mode: 'observe', label: '观察' },
          { mode: 'auto', label: '自动' },
        ]
        var modalTitle = tab === 'rules' ? '验收规矩' : tab === 'vents' ? 'Agent 吐槽' : '自动开工'
        return hh('div', {
          className: 'sa2-pop',
          onClick: function (event) {
            if (event.target === event.currentTarget) patch({ routerOpen: false, quietSaved: false })
          },
        },
          hh('div', { className: 'sa2-popcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': modalTitle },
            hh('h3', null, modalTitle),
            hh('div', { className: 'sa2-mdl-tabs', role: 'tablist' },
              hh('button', {
                type: 'button', role: 'tab', className: 'sa2-mdl-tab',
                'aria-selected': tab === 'router' ? 'true' : 'false',
                onClick: function () { patch({ modalTab: 'router' }) },
              }, '自动调度'),
              hh('button', {
                type: 'button', role: 'tab', className: 'sa2-mdl-tab',
                'aria-selected': tab === 'rules' ? 'true' : 'false',
                onClick: function () { patch({ modalTab: 'rules' }) },
              }, '验收规矩' + (rules.count ? ' (' + rules.count + ')' : '')),
              hh('button', {
                type: 'button', role: 'tab', className: 'sa2-mdl-tab',
                'aria-selected': tab === 'vents' ? 'true' : 'false',
                onClick: function () { patch({ modalTab: 'vents' }) },
              }, 'Agent 吐槽' + (vents.count ? ' (' + vents.count + ')' : '')),
            ),
            tab === 'router'
              ? hh('div', null,
                  hh('p', { className: 'lead' }, '新装的默认是观察：只算「本来会开始」，不动手。'),
                  hh('div', { className: 'sa2-modes' }, modes.map(function (row) {
                    return hh('button', {
                      key: row.mode,
                      type: 'button',
                      className: 'sa2-opt',
                      'aria-pressed': router.mode === row.mode ? 'true' : 'false',
                      disabled: S.busy === 'router',
                      onClick: function () { routerSet('router_mode', row.mode) },
                    }, row.label)
                  })),
                  hh('p', { className: 'lead', style: { marginTop: 18 } }, '同时最多跑几件'),
                  hh('div', { className: 'sa2-limits' }, [1, 2, 3, 4, 5].map(function (limit) {
                    return hh('button', {
                      key: String(limit),
                      type: 'button',
                      className: 'sa2-opt',
                      'aria-pressed': router.maxRunning === limit ? 'true' : 'false',
                      disabled: S.busy === 'router',
                      onClick: function () { routerSet('router_limit', limit) },
                    }, String(limit))
                  })),
                  hh('label', { className: 'sa2-checkline' },
                    hh('input', {
                      type: 'checkbox',
                      checked: router.sameDir !== 'allow',
                      disabled: S.busy === 'router',
                      onChange: function (event) {
                        routerSet('router_same_dir', event.target.checked ? 'wait' : 'allow')
                      },
                    }),
                    hh('span', null, '同一个目录同时只跑一件'),
                  ),
                  hh('label', { className: 'sa2-checkline' },
                    hh('input', {
                      type: 'checkbox',
                      checked: notify.mode === 'on',
                      disabled: S.busy === 'notify',
                      onChange: function (event) { notifySet('notify_mode', event.target.checked ? 'on' : 'off') },
                    }),
                    hh('span', null, '有事等我时发通知'),
                  ),
                  hh('p', { className: 'lead', style: { marginTop: 10 } }, '安静时段'),
                  hh('div', { className: 'sa2-checkline' },
                    hh('input', {
                      type: 'time',
                      value: quiet.from,
                      disabled: S.busy === 'notify',
                      style: { width: 88 },
                      onChange: function (event) {
                        var nextFrom = event.target.value
                        var to = quiet.to || '08:00'
                        patch({ quietDraft: { from: nextFrom, to: to } })
                        if (nextFrom && to) notifySet('notify_quiet', nextFrom + '-' + to)
                      },
                    }),
                    hh('span', null, '到'),
                    hh('input', {
                      type: 'time',
                      value: quiet.to,
                      disabled: S.busy === 'notify',
                      style: { width: 88 },
                      onChange: function (event) {
                        var nextTo = event.target.value
                        var from = quiet.from || '23:00'
                        patch({ quietDraft: { from: from, to: nextTo } })
                        if (from && nextTo) notifySet('notify_quiet', from + '-' + nextTo)
                      },
                    }),
                    S.quietSaved
                      ? hh('span', { className: 'sa2-autosave-tag' }, '✓ 已自动保存')
                      : hh('span', { className: 'sa2-sm' }, '改完自动保存'),
                  ),
                  S.rowError && S.rowError.id === 'notify'
                    ? hh('p', { className: 'sa2-err' }, S.rowError.message)
                    : null,
                  hh('p', { className: 'lead', style: { marginTop: 6 } },
                    notify.lastError
                      ? '上次没发出去：' + notify.lastError
                      : notify.status === 'unconfigured'
                        ? '还没配置发送方式'
                        : notify.status === 'off'
                          ? '通知关着'
                          : notify.configured
                            ? '已配置'
                            : '还没配置发送方式'),
                  hh('div', { style: { marginTop: 16 } },
                    hh('p', { className: 'lead' }, '这个项目的规矩 ' + rules.count + ' 条'),
                    hh('div', { className: 'sa2-rule-list' }, rules.items.map(function (rule) {
                      return hh('div', { className: 'sa2-rule', key: rule.id },
                        hh('small', { className: 'sa2-sm' }, wsLabel(rule.workspacePath)),
                        hh('span', null, rule.text),
                        hh('button', {
                          type: 'button', className: 'sa2-link',
                          onClick: function () { refreshWith({ action: 'rule_delete', text: rule.id }) },
                        }, '删'),
                      )
                    })),
                    S.rowError && S.rowError.id === 'rules'
                      ? hh('p', { className: 'sa2-err' }, S.rowError.message)
                      : null,
                  ),
                  hh('p', { className: 'lead', style: { marginTop: 18 } },
                    '观察档只记「本来会开始」；自动档有空位就开工，手动点「开始」不受上限和同目录限制。'),
                )
              : null,
            tab === 'rules'
              ? hh('div', null,
                  hh('p', { className: 'lead' }, '打回卡片时勾选「以后这个项目都按这条查」，会自动沉淀到对应项目的验收清单。'),
                  hh('p', { className: 'lead', style: { marginTop: 12 } }, '这个项目的规矩 ' + rules.count + ' 条'),
                  rules.items.length
                    ? hh('div', { className: 'sa2-rule-list' }, rules.items.map(function (rule) {
                        return hh('div', { className: 'sa2-rule', key: rule.id },
                          hh('small', { className: 'sa2-sm' }, wsLabel(rule.workspacePath)),
                          hh('span', null, rule.text),
                          hh('button', {
                            type: 'button', className: 'sa2-link',
                            onClick: function () { refreshWith({ action: 'rule_delete', text: rule.id }) },
                          }, '删'),
                        )
                      }))
                    : hh('p', { className: 'sa2-empty' }, '还没有记住的验收规矩。'),
                  S.rowError && S.rowError.id === 'rules'
                    ? hh('p', { className: 'sa2-err' }, S.rowError.message)
                    : null,
                )
              : null,
            tab === 'vents'
              ? hh('div', null,
                  hh('p', { className: 'lead' }, 'Agent 干活时顺带留下的槽点或潜在债务，可直接记成正式卡片，或标为已知。'),
                  hh('p', { className: 'lead', style: { marginTop: 12 } }, 'AGENT 吐槽 ' + vents.count + ' 条'),
                  vents.items.length
                    ? hh('div', { className: 'sa2-rule-list' }, vents.items.map(function (vent) {
                        return hh('div', { className: 'sa2-rule', key: vent.id },
                          hh('span', null, vent.text),
                          hh('button', {
                            type: 'button', className: 'sa2-link',
                            onClick: function () { refreshWith({ action: 'vent_card', text: vent.id }) },
                          }, '记成一件事'),
                          hh('button', {
                            type: 'button', className: 'sa2-link',
                            onClick: function () { refreshWith({ action: 'vent_dismiss', text: vent.id }) },
                          }, '知道了'),
                        )
                      }))
                    : hh('p', { className: 'sa2-empty' }, '现在没有新的 Agent 吐槽。'),
                  S.rowError && S.rowError.id === 'vents'
                    ? hh('p', { className: 'sa2-err' }, S.rowError.message)
                    : null,
                )
              : null,
            hh('div', { className: 'sa2-pop-foot' },
              hh('span', { className: 'grow' }),
              hh('button', {
                type: 'button',
                className: 'sa2-link',
                onClick: function () { patch({ routerOpen: false, quietSaved: false }) },
              }, '关闭'),
            ),
          ),
        )
      }

      function renderPicker() {
        var picker = S.picker
        if (canUseWorkspacePicker(props) && (!picker || picker.native)) {
          var meta = (picker && picker.native) ? picker : nativeTargetRef.current
          var pickerOpen = Boolean(picker && picker.native && picker.open !== false)
          var curPath = meta
            ? (meta.target === 'composer'
                ? (S.composerWorkspace === undefined ? (S.view && S.view.defaultWorkspace) : S.composerWorkspace)
                : ((findCard(S.view, meta.id) || {}).workspacePath || null))
            : null
          return props.renderFactorySlot('workspace.picker', {
            open: pickerOpen,
            anchorRef: pickerAnchorRef,
            selectedId: workspaceIdByPath(curPath),
            onPick: function (wsId) {
              var activeMeta = nativeTargetRef.current || (picker && picker.native ? picker : null)
              var p = pathByWorkspaceId(wsId)
              if (p && activeMeta) {
                pick(p, activeMeta)
              } else {
                nativeTargetRef.current = null
                patch({ picker: null })
              }
            },
            onClose: function () {
              patch(function (prev) {
                return prev.picker && prev.picker.native
                  ? { picker: Object.assign({}, prev.picker, { open: false }) }
                  : {}
              })
            },
          })
        }
        if (!picker) return null
        var list = (S.view && S.view.workspaces) || []
        return hh('div', {
          className: 'sa2-pop',
          onClick: function (event) {
            if (event.target === event.currentTarget) patch({ picker: null })
          },
        },
          hh('div', { className: 'sa2-popcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': '在哪做' },
            hh('h3', null, '在哪做'),
            hh('p', { className: 'lead' }, '从台账里用过的目录里选，不扫磁盘。'),
            list.map(function (row) {
              return hh('button', {
                key: row.path,
                type: 'button',
                className: 'sa2-pick',
                onClick: function () { pick(row.path) },
              },
                hh('div', { className: 'p' }, hh('b', null, row.label), hh('span', null, row.path)),
                hh('small', null, row.count + ' 件'),
              )
            }),
            picker.other
              ? hh('div', { className: 'sa2-pop-other' },
                  hh('input', {
                    autoFocus: true,
                    value: picker.path || '',
                    placeholder: '/Users/… 绝对路径',
                    onChange: function (event) {
                      var value = event.target.value
                      patch(function (prev) {
                        return { picker: Object.assign({}, prev.picker, { path: value, error: null }) }
                      })
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitOther()
                      }
                    },
                  }),
                  hh('button', { type: 'button', className: 'sa2-btn pri', onClick: submitOther }, '用这个目录'),
                )
              : hh('button', {
                  type: 'button',
                  className: 'sa2-link',
                  style: { marginTop: 12, fontSize: 12 },
                  onClick: function () {
                    patch(function (prev) {
                      return { picker: Object.assign({}, prev.picker, { other: true }) }
                    })
                  },
                }, '其他目录…'),
            picker.error ? hh('p', { className: 'sa2-err' }, picker.error) : null,
            hh('div', { className: 'sa2-pop-foot' },
              hh('button', {
                type: 'button',
                className: 'sa2-btn',
                onClick: function () { pick(null) },
              }, picker.target === 'composer' || picker.mode === 'workspace' ? '先不定' : '取消'),
              hh('span', { className: 'grow' }),
              hh('button', {
                type: 'button',
                className: 'sa2-link',
                onClick: function () { patch({ picker: null }) },
              }, '关闭'),
            ),
          ),
        )
      }

      function renderDrawer() {
        var drawer = S.drawer
        if (!drawer) return null
        var detail = drawer.detail
        var liveCard = detail ? findCard(S.view, detail.id) : null
        var cardActions = (liveCard && liveCard.actions) || (detail && detail.actions) || []
        var stageText = detail && STAGE_WORD[detail.stage]
        var isDrawerForm = Boolean(S.form && detail && S.form.id === detail.id && S.form.inDrawer)
        var rows = []
        if (detail) {
          rows.push(hh('h2', { key: 'title' }, detail.title))
          if (detail.reason) rows.push(hh('p', { className: 'sa2-sm', key: 'reason', style: { marginTop: 8 } }, detail.reason))
          if (detail.workspacePath) {
            rows.push(hh('p', { className: 'sa2-kv', key: 'ws' },
              hh('span', null, '在哪做'),
              hh('span', { className: 'sa2-mono' }, detail.workspaceLabel || wsLabel(detail.workspacePath)),
              hh('span', { className: 'sa2-mono', title: detail.workspacePath }, detail.workspacePath),
            ))
          } else {
            rows.push(hh('p', { className: 'sa2-sm', key: 'ws', style: { marginTop: 8 } }, '还没定在哪做'))
          }
          if (detail.description) {
            rows.push(hh('h3', { key: 'dh' }, '描述'))
            rows.push(hh('p', { key: 'd' }, detail.description))
          }
          if (detail.checklist && detail.checklist.length) {
            rows.push(hh('h3', { key: 'ch' }, '验收清单'))
            rows.push(hh('div', { key: 'cl' }, detail.checklist.map(function (item) {
              return hh('div', { className: 'sa2-check', key: item.id },
                hh('i', null, item.checked ? '✓' : ''),
                hh('span', null, item.text, item.note ? hh('span', { className: 'sa2-sm' }, ' · ' + item.note) : null, evidenceChips(item.evidence)),
              )
            })))
          }
          if (detail.question) {
            rows.push(hh('h3', { key: 'qh' }, '在等你回答'))
            rows.push(hh('p', { key: 'q' }, detail.question.text))
            if (detail.question.options && detail.question.options.length) {
              rows.push(hh('p', { className: 'sa2-sm', key: 'qo' }, '选项：' + detail.question.options.join(' / ')))
            }
          }
          if (detail.executions && detail.executions.length) {
            rows.push(hh('h3', { key: 'eh' }, '报告'))
            detail.executions.forEach(function (execution, index) {
              rows.push(hh('article', { className: 'sa2-report', key: execution.id || ('e' + index) },
                hh('div', { className: 'sa2-report-h' },
                  hh('b', null, outcomeText(execution.outcome)),
                  execution.by === 'mcp' ? hh('span', { className: 'sa2-badge is-ext' }, '外部 Agent 交的') : null,
                  hh('span', null, formatAt(execution.at)),
                ),
                execution.summary ? hh('p', null, execution.summary) : null,
                execution.changedFiles && execution.changedFiles.length
                  ? hh('p', { className: 'sa2-sm' }, '改了：' + execution.changedFiles.join('、'))
                  : null,
                execution.checks && execution.checks.length
                  ? hh('p', { className: 'sa2-sm' }, '验证：' + execution.checks.join('、'))
                  : null,
                execution.risk ? hh('p', { className: 'sa2-sm' }, '风险：' + execution.risk) : null,
              ))
            })
          }
          if (detail.assignments && detail.assignments.length) {
            rows.push(hh('h3', { key: 'ah' }, '派工记录'))
            detail.assignments.slice().reverse().forEach(function (assignment, index) {
              var line = []
              if (assignment.startedAt) line.push('开始 ' + formatAt(assignment.startedAt))
              if (assignment.endedAt) line.push('结束 ' + formatAt(assignment.endedAt))
              if (assignment.endReason) line.push('原因 ' + (END_REASON[assignment.endReason] || assignment.endReason))
              if (assignment.lastTurn && assignment.lastTurn.endKind) line.push('最后一轮 ' + (END_KIND[assignment.lastTurn.endKind] || assignment.lastTurn.endKind))
              rows.push(hh('div', { className: 'sa2-asg', key: assignment.id || ('a' + index) },
                hh('span', { className: 'sa2-mono' }, '会话 ' + shortSession(assignment.sessionId)),
                hh('span', { className: 'st' }, stateText(assignment.state) + (line.length ? ' · ' + line.join(' · ') : '')),
                hh('span', { className: 'sa2-sm' }, assignment.waitingApproval ? '等你批准' : ''),
              ))
            })
          }
          if (detail.comments && detail.comments.length) {
            rows.push(hh('h3', { key: 'mh' }, '留言'))
            detail.comments.forEach(function (comment, index) {
              rows.push(hh('div', { className: 'sa2-report', key: comment.id || ('c' + index) },
                hh('div', { className: 'sa2-report-h' },
                  hh('b', null, commentAuthor(comment.author)),
                  hh('span', null, formatAt(comment.at)),
                ),
                hh('p', null, comment.body),
              ))
            })
          }
          rows.push(hh('div', { className: 'sa2-comment', key: 'comment' },
            hh('input', {
              value: drawer.comment || '',
              placeholder: '补一句，送到这件事的会话',
              onChange: function (event) {
                var value = event.target.value
                patch(function (prev) {
                  return { drawer: Object.assign({}, prev.drawer, { comment: value }) }
                })
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitComment()
                }
              },
            }),
            hh('button', {
              type: 'button',
              className: 'sa2-btn pri',
              disabled: S.busy === drawer.id || !String(drawer.comment || '').trim(),
              onClick: submitComment,
            }, '送出'),
          ))
        }
        return hh('div', {
          className: 'sa2-scrim',
          onClick: function (event) {
            if (event.target === event.currentTarget) closeDrawer()
          },
        },
          hh('aside', { className: 'sa2-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': detail ? detail.title : '卡片详情' },
            hh('div', { className: 'sa2-drw-head' },
              hh('div', { className: 'sa2-drw-meta' },
                detail
                  ? [
                      hh('span', { key: 'ws', className: 'sa2-badge' }, detail.workspacePath ? (detail.workspaceLabel || wsLabel(detail.workspacePath)) : '未定目录'),
                      stageText ? hh('span', { key: 'st', className: 'sa2-badge' }, stageText) : null,
                      hh('button', {
                        key: 'id',
                        type: 'button',
                        className: 'sa2-drw-id',
                        title: '点击复制卡号',
                        onClick: function () { copyWithFeedback(detail.id, '卡号已复制：' + detail.id, '卡号：' + detail.id) },
                      }, detail.code ? detail.code + ' · ' + detail.id : detail.id),
                      hh('button', {
                        key: 'cli',
                        type: 'button',
                        className: 'sa2-cli-btn',
                        title: '复制外部 CLI 派工指令（DSH MCP 验收闭环）',
                        onClick: function () { copyCliBrief(liveCard || detail) },
                      }, '📋 复制外部 CLI 派工指令'),
                    ]
                  : hh('span', { className: 'sa2-eyebrow' }, '卡片详情'),
              ),
              hh('button', { type: 'button', className: 'x', onClick: closeDrawer }, '关闭'),
            ),
            hh('div', { className: 'sa2-drw-body' },
              drawer.loading ? hh('p', { className: 'sa2-loading' }, '正在读这张卡…') : null,
              drawer.error ? hh('p', { className: 'sa2-err' }, drawer.error) : null,
              rows,
            ),
            detail && (cardActions.length > 0 || isDrawerForm)
              ? hh('div', { className: 'sa2-drw-foot' },
                  isDrawerForm ? renderForm(liveCard || detail, true) : null,
                  S.rowError && S.rowError.id === detail.id
                    ? hh('p', { className: 'sa2-err' }, S.rowError.message)
                    : null,
                  cardActions.length > 0
                    ? hh('div', { className: 'sa2-drw-foot-btns' },
                        cardActions.map(function (definition, index) {
                          return renderAction(liveCard || detail, definition, index, true)
                        }),
                        hh('span', { className: 'sa2-drw-foot-tip' }, detail.stage === 'review' ? '核对报告与证据后可直接拍板' : '点按钮直接推进'),
                      )
                    : null,
                )
              : null,
          ),
        )
      }

      function renderToast() {
        if (!S.toast) return null
        var canUndo = !!(
          S.toast.undoId
          || (S.toast.undoPending && S.toast.undoPending.length)
          || (S.toast.undoRestoreIds && S.toast.undoRestoreIds.length)
        )
        return hh('div', { className: 'sa2-toast', role: 'status' },
          hh('span', null, S.toast.text),
          canUndo
            ? hh('button', { type: 'button', onClick: undo }, '撤销')
            : null,
        )
      }

      function renderOnboarding() {
        var samples = [
          '排查最近一次失败的单元测试并补全回归验证',
          '整理当前未提交改动并输出关键路径检查报告',
          '梳理今天会话里零散提到的修复点，形成待办清单',
        ]
        return hh('section', { className: 'sa2-onboarding', 'aria-label': '快速上手' },
          hh('div', { className: 'sa2-ob-head' },
            hh('h2', null, '看板还是空的 · 3 步跑通人机验收闭环'),
            hh('span', { className: 'sa2-sm' }, '也可以用会话快捷键抓进待办'),
          ),
          hh('div', { className: 'sa2-ob-steps' },
            hh('div', { className: 'sa2-ob-step' },
              hh('b', null, '1. 说一件事先落卡'),
              '在上面写一句话；默认进自动队列，也可以切到「先放以后再说」。',
            ),
            hh('div', { className: 'sa2-ob-step' },
              hh('b', null, '2. 自己跑或贴给 CLI'),
              '等或排队的卡点「复制给 CLI」，可直接派给 Codex / Claude 按 MCP 规范交工。',
            ),
            hh('div', { className: 'sa2-ob-step' },
              hh('b', null, '3. 核对证据再通过'),
              'Agent 交回成果和实测证据后，一键「通过」或「打回」并顺手沉淀成规矩。',
            ),
          ),
          hh('div', { className: 'sa2-ob-prompts' }, samples.map(function (sample, index) {
            return hh('button', {
              key: index,
              type: 'button',
              className: 'sa2-ob-try',
              onClick: function () { patch({ composer: sample, composerError: null }) },
            }, '试试：' + sample)
          })),
        )
      }

      function renderFilterBar(totalCards) {
        if (!totalCards) return null
        var byWs = {}
        var order = []
        var unsetCount = 0
        GROUPS.forEach(function (key) {
          var list = (S.view && S.view.groups && S.view.groups[key]) || []
          list.forEach(function (card) {
            if (card.workspacePath) {
              if (!byWs[card.workspacePath]) {
                byWs[card.workspacePath] = { path: card.workspacePath, label: card.workspaceLabel || wsLabel(card.workspacePath), count: 0 }
                order.push(card.workspacePath)
              }
              byWs[card.workspacePath].count += 1
            } else {
              unsetCount += 1
            }
          })
        })
        var currentFilter = S.filterWs || 'all'
        return hh('div', { className: 'sa2-filter-bar', role: 'search', 'aria-label': '按项目和关键字筛选卡片' },
          hh('div', { className: 'sa2-proj-pills' },
            hh('button', {
              type: 'button',
              className: 'sa2-fpill',
              'aria-pressed': currentFilter === 'all' ? 'true' : 'false',
              onClick: function () { patch({ filterWs: 'all' }) },
            }, '全部 ', hh('small', null, String(totalCards))),
            order.map(function (path) {
              var entry = byWs[path]
              return hh('button', {
                key: path,
                type: 'button',
                className: 'sa2-fpill',
                title: path,
                'aria-pressed': currentFilter === path ? 'true' : 'false',
                onClick: function () { patch({ filterWs: currentFilter === path ? 'all' : path }) },
              }, entry.label + ' ', hh('small', null, String(entry.count)))
            }),
            unsetCount > 0
              ? hh('button', {
                  type: 'button',
                  className: 'sa2-fpill',
                  'aria-pressed': currentFilter === '__unset__' ? 'true' : 'false',
                  onClick: function () { patch({ filterWs: currentFilter === '__unset__' ? 'all' : '__unset__' }) },
                }, '未定目录 ', hh('small', null, String(unsetCount)))
              : null,
          ),
          hh('label', { className: 'sa2-search' },
            hh('input', {
              value: S.query || '',
              placeholder: '搜标题 / 卡号 / 目录…',
              'aria-label': '搜索卡片',
              onChange: function (event) { patch({ query: event.target.value }) },
            }),
            S.query
              ? hh('button', {
                  type: 'button',
                  'aria-label': '清除搜索',
                  onClick: function () { patch({ query: '' }) },
                }, '✕')
              : null,
          ),
        )
      }

      if (S.loading && !S.view) {
        return hh('div', { className: 'sa2' }, hh('div', { className: 'sa2-inner' },
          hh('p', { className: 'sa2-loading' }, '正在读取台账…'),
        ))
      }

      if (!S.view) {
        return hh('div', { className: 'sa2' }, hh('div', { className: 'sa2-inner' },
          hh('div', { className: 'sa2-error' },
            hh('h2', null, '读不到台账'),
            hh('p', null, S.error || '宿主没有返回数据'),
            hh('button', {
              type: 'button',
              className: 'sa2-btn pri',
              style: { marginTop: 16 },
              onClick: function () { patch(function (prev) { return { loading: true, error: null, refresh: prev.refresh + 1 } }) },
            }, '再读一次'),
          ),
        ))
      }

      var counts = S.view.counts || { waiting: 0, running: 0, queued: 0, later: 0, doneToday: 0 }
      var waiting = counts.waiting || 0
      var totalCards = GROUPS.reduce(function (sum, key) {
        return sum + (((S.view && S.view.groups && S.view.groups[key]) || []).length)
      }, 0)
      var pendingCount = ((S.view && S.view.pending) || []).length
      var router = (S.view && S.view.router) || { mode: 'observe', maxRunning: 2 }
      var rules = (S.view && S.view.acceptanceRules) || { count: 0 }
      var vents = (S.view && S.view.vents) || { count: 0 }
      var rest = (totalCards === 0 && pendingCount === 0)
        ? '写一句想做的事，或用会话快捷键随时抓进台账。'
        : '另外 ' + (counts.running || 0) + ' 件在跑，' + (counts.queued || 0) + ' 件排队。'

      return hh('div', { className: 'sa2' },
        hh('div', { className: 'sa2-inner' },
          hh('div', { className: 'sa2-top' },
            hh('p', { className: 'sa2-eyebrow' }, 'SUPER AGENT', hh('span', { className: 'sa2-live' }, hh('i'), '本机台账')),
            hh('div', { className: 'sa2-status-pills' },
              hh('button', {
                type: 'button',
                className: 'sa2-pill',
                onClick: function () { patch({ routerOpen: true, modalTab: 'router', quietSaved: false }) },
              },
                hh('span', { className: 'sa2-dot ' + (router.mode === 'auto' ? 'auto' : router.mode === 'observe' ? 'observe' : '') }),
                modeWord(router.mode) + ' · 最多 ' + router.maxRunning + ' 件',
              ),
              hh('button', {
                type: 'button',
                className: 'sa2-pill',
                onClick: function () { patch({ routerOpen: true, modalTab: 'rules', quietSaved: false }) },
              }, '规矩 ', hh('span', { className: 'sa2-badge-num' }, String(rules.count || 0))),
              hh('button', {
                type: 'button',
                className: 'sa2-pill' + (vents.count ? ' has-vent' : ''),
                onClick: function () { patch({ routerOpen: true, modalTab: 'vents', quietSaved: false }) },
              }, '吐槽 ', hh('span', { className: 'sa2-badge-num' }, String(vents.count || 0))),
            ),
          ),
          hh('h1', { className: 'sa2-h1' },
            waiting
              ? [hh('b', { className: 'n', key: 'n' }, String(waiting)), ' 件事在等你。']
              : '现在没有事等你。',
            hh('span', { className: 'rest' }, rest),
          ),
          S.error ? hh('p', { className: 'sa2-banner' }, '读不到最新台账：' + S.error) : null,
          renderComposer(),
          S.composerError ? hh('p', { className: 'sa2-say-note' }, S.composerError) : null,
          totalCards === 0 && pendingCount === 0 ? renderOnboarding() : null,
          hh('div', { className: 'sa2-field', role: 'navigation', 'aria-label': '全部事情，按轮到谁分', ref: fieldRef },
            GROUPS.map(renderZone),
          ),
          renderFilterBar(totalCards),
          renderTabs(),
          GROUPS.map(function (key) {
            // 待确认紧跟「等你」，不压到排队末尾；它默认收着，不抢首屏。
            var parts = [renderSection(key)]
            if (key === 'waiting') parts.push(renderPendingRail())
            return parts
          }),
          renderVents(),
        ),
        renderRouterPop(),
        renderPicker(),
        renderDrawer(),
        renderToast(),
      )
    }

    function apply(ctx) {
      hostUi.slots = ctx && ctx.slots ? ctx.slots : null
      ctx.effect(function () {
        hostUi.slots = ctx && ctx.slots ? ctx.slots : null
        ensureStyle()
        return function () {
          hostUi.slots = null
          boardListeners.clear()
        }
      })
      function bindUiWorkspace(service) {
        if (service && typeof service.openSession === 'function') {
          hostUi.openSession = id => service.openSession(id)
          hostUi.canOpen = true
        }
      }
      function bindWorkspaces(service) {
        hostUi.workspaces = service || null
      }
      function bindSessions(service) {
        hostUi.sessions = service || null
      }
      try {
        bindUiWorkspace(ctx.get && ctx.get('uiWorkspace', false))
      } catch (error) {
        // 服务还没挂上，等注入。
      }
      try {
        bindWorkspaces(ctx.get && ctx.get('workspaces', false))
      } catch (error) {
        // RC2 或无工作区服务时退回台账列表。
      }
      try {
        bindSessions(ctx.get && ctx.get('sessions', false))
      } catch (error) {
        // 拿不到前台会话时按默认工作区建卡。
      }
      try {
        if (typeof ctx.inject === 'function') {
          ctx.effect(() => ctx.inject(['uiWorkspace'], scope => {
            bindUiWorkspace(scope && (scope.uiWorkspace || (scope.get && scope.get('uiWorkspace', false))))
            return function () {
              hostUi.openSession = null
              hostUi.canOpen = false
            }
          }))
          ctx.effect(() => ctx.inject(['workspaces'], scope => {
            bindWorkspaces(scope && (scope.workspaces || (scope.get && scope.get('workspaces', false))))
            return function () {
              hostUi.workspaces = null
            }
          }))
          ctx.effect(() => ctx.inject(['sessions'], scope => {
            bindSessions(scope && (scope.sessions || (scope.get && scope.get('sessions', false))))
            return function () {
              hostUi.sessions = null
            }
          }))
        }
      } catch (error) {
        // 没有对应服务时按旧行为降级。
      }
      ctx.effect(() => ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
        name: 'sidebar.session.action', id: 'superagent-quick-capture',
      }, QuickCaptureAction)))
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_KEY,
      }, Panel)))
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_KEY, order: 90, label: 'Super Agent',
      }, Icon)))
    }

    exports.name = '@oxmumu3/dsh-superagent/client'
    exports.inject = ['slots']
    exports.apply = apply

    return module.exports
  },
})
