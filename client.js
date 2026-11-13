// dsh-superagent — 浏览器端 half（client bundle）。
//
// 手写 CJS + window.__ModuleLoader__ 包装，零构建。**不能出现 ESM 的 export。**
// 挂载点按宿主槽位目录的精确契约：
//   sidebar.panellist  list  注册 { id, order, label }，组件收 { size, active }
//   main               keyed 注册 { key }，组件是面板本体
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
    var hostUi = { openSession: null, canOpen: false }

    function loadReact() {
      try {
        var mod = require('react')
        return mod && mod.createElement ? mod : mod && mod.default
      } catch (error) {
        return null
      }
    }

    var GROUPS = ['waiting', 'running', 'queued', 'later', 'doneToday']
    var WAITING_STAGES = ['not_started', 'not_delivered', 'approval', 'question', 'review', 'stuck', 'silent']
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

    // 颜色只用宿主语义 token；回退值只在宿主变量缺失时兜底。
    var CSS = [
      '.sa2{--sa2-ink:var(--dsw-alias-label-primary,#17191c);',
      '--sa2-ink2:var(--dsw-alias-label-secondary,#4a4f57);',
      '--sa2-ink3:var(--dsw-alias-label-tertiary,#828891);',
      '--sa2-ink4:var(--dsw-alias-label-caption,#b6bac0);',
      '--sa2-bg:var(--dsw-alias-bg-base,#f7f7f5);',
      '--sa2-card:var(--dsw-alias-bg-layer-2,#fff);',
      '--sa2-line:var(--dsw-alias-border-l2,#e6e6e1);',
      '--sa2-line2:var(--dsw-alias-border-l4,#cfcfc8);',
      '--sa2-hover:var(--dsw-alias-interactive-bg-hover,rgba(23,25,28,.05));',
      '--sa2-run:var(--dsw-alias-link,#4d6bfe);',
      '--sa2-wait:var(--dsw-alias-state-warn-primary,#c97a00);',
      '--sa2-stuck:var(--dsw-alias-state-error-primary,#d0453f);',
      '--sa2-ok:var(--dsw-alias-state-success-primary,#2f8a57);',
      '--sa2-sans:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif);',
      '--sa2-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;',
      '--sa2-ease:cubic-bezier(.2,.8,.2,1);',
      'min-height:100%;background:var(--sa2-bg);color:var(--sa2-ink);',
      'font:14px/22px var(--sa2-sans);-webkit-font-smoothing:antialiased;container-type:inline-size;container-name:sa2}',
      '.sa2,.sa2 *{box-sizing:border-box}',
      '.sa2 :is(h1,h2,h3,p,ul,ol,figure){margin:0;padding:0}',
      '.sa2 :is(ul,ol){list-style:none}',
      '.sa2 button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',
      '.sa2 input,.sa2 textarea{font:inherit;color:inherit}',
      '.sa2 :focus-visible{outline:2px solid var(--sa2-run);outline-offset:2px;border-radius:4px}',
      '@media (prefers-reduced-motion:reduce){.sa2 *{animation:none!important;transition:none!important}}',
      '.sa2-inner{max-width:920px;margin:0 auto;padding:40px 36px 110px;width:100%}',
      '.sa2-eyebrow{display:flex;align-items:center;gap:10px;font:11px/16px var(--sa2-mono);letter-spacing:.1em;color:var(--sa2-ink3);text-transform:uppercase}',
      '.sa2-live{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border:1px solid var(--sa2-line2);border-radius:999px;letter-spacing:.02em;text-transform:none;font-family:var(--sa2-sans)}',
      '.sa2-live i{width:6px;height:6px;border-radius:50%;background:var(--sa2-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-ok) 16%,transparent)}',
      '.sa2-h1{margin-top:14px;font:600 30px/40px var(--sa2-sans);letter-spacing:-.015em;text-wrap:balance}',
      '.sa2-h1 b{font-weight:600}',
      '.sa2-h1 .n{color:var(--sa2-wait)}',
      '.sa2-h1 .rest{color:var(--sa2-ink2);font-weight:500}',
      '.sa2-banner{margin-top:14px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--sa2-stuck) 40%,var(--sa2-line));border-radius:10px;background:color-mix(in srgb,var(--sa2-stuck) 7%,var(--sa2-card));font-size:12px;color:var(--sa2-stuck)}',
      '.sa2-say{display:flex;align-items:center;gap:8px;margin-top:22px;padding:6px 6px 6px 20px;border:1px solid var(--sa2-ink3);border-radius:999px;background:var(--sa2-card);box-shadow:0 2px 10px rgba(0,0,0,.04);transition:border-color .16s var(--sa2-ease),box-shadow .16s var(--sa2-ease)}',
      '.sa2-say:focus-within{border-color:var(--sa2-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--sa2-ink) 10%,transparent)}',
      '.sa2-say input{flex:1;min-width:0;border:0;outline:0;background:none;height:42px;font-size:15px}',
      '.sa2-say input::placeholder{color:var(--sa2-ink3)}',
      '.sa2-chip{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:999px;font-size:12px;color:var(--sa2-ink2);white-space:nowrap;max-width:210px}',
      '.sa2-chip b{font-weight:500;overflow:hidden;text-overflow:ellipsis}',
      '.sa2-chip:hover{background:var(--sa2-hover)}',
      '.sa2-send{flex:none;height:42px;padding:0 24px;border-radius:999px;background:var(--sa2-ink);color:var(--sa2-bg);font-size:14px;font-weight:600}',
      '.sa2-send:hover{opacity:.88}',
      '.sa2-send:disabled{opacity:.45;cursor:default}',
      '.sa2-say-note{margin:10px 4px 0;font-size:12px;color:var(--sa2-stuck)}',
      // 待确认默认收成一条计数入口，放在「等你」后面；展开先看短预览。
      '.sa2-pending{margin-top:28px;border:1px solid var(--sa2-line);border-radius:14px;background:var(--sa2-card);overflow:hidden}',
      '.sa2-pending-head{display:flex;align-items:center;gap:9px;width:100%;padding:11px 14px;text-align:left}',
      '.sa2-pending-head:hover{background:var(--sa2-hover)}',
      '.sa2-pending-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border:1px dashed var(--sa2-ink3);border-radius:50%;font:600 11px/1 var(--sa2-mono);color:var(--sa2-ink3)}',
      '.sa2-pending-name{flex:none;font-weight:600;font-size:13px;line-height:20px;color:var(--sa2-ink)}',
      '.sa2-pending-n{flex:none;font:600 15px/20px var(--sa2-sans);color:var(--sa2-ink);font-variant-numeric:tabular-nums}',
      '.sa2-pending-hint{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--sa2-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sa2-pending-go{flex:none;font-size:12px;color:var(--sa2-ink2);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-pending-body{border-top:1px solid var(--sa2-line)}',
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
      '.sa2-field{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(4,minmax(0,1fr));gap:1px;margin-top:24px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-line);overflow:hidden}',
      '.sa2-zone{position:relative;min-width:0;padding:14px 16px;background:var(--sa2-card);text-align:left;transition:background .16s var(--sa2-ease)}',
      '.sa2-zone:hover{background:color-mix(in srgb,var(--sa2-ink) 4%,var(--sa2-card))}',
      '.sa2-zone.is-wait{background:color-mix(in srgb,var(--sa2-wait) 9%,var(--sa2-card))}',
      '.sa2-zone.is-wait.zero{background:var(--sa2-card)}',
      '.sa2-zone-k{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-zone-k b{font:600 24px/30px var(--sa2-sans);color:var(--sa2-ink);font-variant-numeric:tabular-nums}',
      '.sa2-zone.is-wait b{color:var(--sa2-wait)}',
      '.sa2-zone.is-wait.zero b{color:var(--sa2-ink)}',
      '.sa2-marks{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px;min-height:15px}',
      '.sa2-mk{width:10px;height:15px;border-radius:3px;background:var(--sa2-ink4);flex:none}',
      '.sa2-mk.run{background:var(--sa2-run)}',
      '.sa2-mk.need{background:var(--sa2-wait)}',
      '.sa2-mk.stuck{background:var(--sa2-stuck)}',
      '.sa2-mk.done{background:var(--sa2-ok)}',
      '.sa2-mk.queue{background:none;border:1.5px solid var(--sa2-ink3)}',
      '.sa2-mk.later{background:var(--sa2-ink4)}',
      '.sa2-mk-more{font:11px/15px var(--sa2-mono);color:var(--sa2-ink3);align-self:center}',
      '.sa2-peek{display:block;margin-top:10px;font-size:12px;line-height:18px;color:var(--sa2-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sa2-under{margin-top:12px;font-size:12px;color:var(--sa2-ink3)}',
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
      '.sa2-sec{margin-top:40px;scroll-margin-top:82px}',
      '.sa2-sec>header{display:flex;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--sa2-line)}',
      '.sa2-sec h2{display:flex;align-items:center;gap:9px;font:600 15px/22px var(--sa2-sans)}',
      '.sa2-count{font:12px/18px var(--sa2-mono);color:var(--sa2-ink3)}',
      '.sa2-hint{margin-left:auto;font-size:12px;color:var(--sa2-ink3);text-align:right}',
      '.sa2-row{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:2px 16px;align-items:center;padding:14px 0;border-bottom:1px solid var(--sa2-line)}',
      '.sa2-row.is-wait{margin:0 -14px;padding-left:14px;padding-right:14px;border-radius:10px;background:linear-gradient(90deg,color-mix(in srgb,var(--sa2-wait) 7%,transparent),transparent 70%)}',
      '.sa2-row.is-stuck{background:linear-gradient(90deg,color-mix(in srgb,var(--sa2-stuck) 8%,transparent),transparent 70%)}',
      '.sa2-row .sa2-mk{align-self:start;margin-top:4px}',
      '.sa2-main{min-width:0}',
      '.sa2-title{display:block;max-width:100%;text-align:left;font-weight:500;font-size:14px;line-height:21px;color:var(--sa2-ink);text-wrap:balance}',
      '.sa2-title:hover{text-decoration:underline;text-underline-offset:3px}',
      '.sa2-why{margin-top:3px;font-size:13px;line-height:20px;color:var(--sa2-ink2);max-width:62ch}',
      '.sa2-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:5px;font-size:12px;line-height:18px;color:var(--sa2-ink3)}',
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
      '.sa2-btn.small{height:26px;padding:0 11px;font-size:12px;line-height:24px}',
      '.sa2-btn:disabled{opacity:.45;cursor:default}',
      '.sa2-form{grid-column:2/-1;display:flex;align-items:center;gap:8px;margin-top:8px;min-width:0}',
      '.sa2-form input{flex:1;min-width:0;height:32px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);outline:0}',
      '.sa2-form input:focus{border-color:var(--sa2-ink)}',
      '.sa2-err{grid-column:2/-1;margin-top:6px;font-size:12px;line-height:18px;color:var(--sa2-stuck)}',
      '.sa2-empty{padding:20px 0 24px;color:var(--sa2-ink3);font-size:13px}',
      '.sa2-more{margin-top:14px;font-size:12px;color:var(--sa2-ink3);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-loading{padding:70px 0;color:var(--sa2-ink3);font-size:13px}',
      '.sa2-error{margin-top:40px;padding:22px 24px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-card)}',
      '.sa2-error h2{font:600 18px/26px var(--sa2-sans)}',
      '.sa2-error p{margin-top:8px;font-size:13px;color:var(--sa2-ink2);word-break:break-word}',
      '.sa2-scrim{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:rgba(0,0,0,.28)}',
      '.sa2-sheet{width:min(460px,100%);height:100%;overflow:auto;background:var(--sa2-bg);border-left:1px solid var(--sa2-line);padding:26px 28px 60px;animation:sa2slide .28s var(--sa2-ease)}',
      '@keyframes sa2slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}',
      '.sa2-sheet .x{float:right;font-size:12px;color:var(--sa2-ink3);border-bottom:1px solid var(--sa2-line2)}',
      '.sa2-sheet h2{font:600 20px/28px var(--sa2-sans);margin-top:10px;text-wrap:balance}',
      '.sa2-sheet h3{margin:24px 0 8px;font:11px/16px var(--sa2-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--sa2-ink3)}',
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
      '.sa2-check code{font:11px/16px var(--sa2-mono);color:var(--sa2-ink3);border:1px solid var(--sa2-line);border-radius:5px;padding:0 4px;margin-left:6px}',
      '.sa2-comment{display:flex;gap:8px;margin-top:18px}',
      '.sa2-comment input{flex:1;min-width:0;height:34px;padding:0 12px;border:1px solid var(--sa2-line2);border-radius:999px;background:var(--sa2-card);outline:0}',
      '.sa2-pop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.24)}',
      '.sa2-popcard{width:min(440px,100%);max-height:82vh;overflow:auto;padding:20px 22px 18px;border:1px solid var(--sa2-line);border-radius:16px;background:var(--sa2-card);box-shadow:0 18px 60px rgba(0,0,0,.24)}',
      '.sa2-popcard h3{font:600 16px/24px var(--sa2-sans)}',
      '.sa2-popcard .lead{margin-top:4px;font-size:12px;color:var(--sa2-ink3)}',
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
      '.sa2-split{display:flex;align-items:center;gap:10px;padding:16px 0 2px;font-size:12px;color:var(--sa2-ink3)}',
      '.sa2-split:before{content:"";flex:1;height:1px;background:var(--sa2-line)}',
      '.sa2-split span{flex:none}',
      '.sa2-checklist{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:18px;color:var(--sa2-ink2)}',
      '.sa2-checklist li{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}',
      '.sa2-checklist .mark{color:var(--sa2-ink3)}',
      '.sa2-checklist em{font-style:normal;color:var(--sa2-ink3)}',
      '.sa2-checklist code{font:11px/16px var(--sa2-mono);color:var(--sa2-ink3);border:1px solid var(--sa2-line);border-radius:5px;padding:0 4px}',
      '.sa2-rule{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;line-height:18px;color:var(--sa2-ink2)}',
      '.sa2-rule span{flex:1}',
      '.sa2-vents{margin-top:28px;padding-top:14px;border-top:1px solid var(--sa2-line)}',
      '.sa2-rule-list{max-height:280px;overflow:auto;padding-right:4px}',
      '.sa2-code{flex:none;margin-right:7px;font:11px/17px var(--sa2-mono);color:var(--sa2-ink3);letter-spacing:.02em}',
      '.sa2-checkline{display:flex;align-items:center;gap:9px;margin-top:16px;font-size:13px;line-height:20px;color:var(--sa2-ink2);cursor:pointer}',
      '.sa2-checkline input{width:16px;height:16px;margin:0;accent-color:var(--sa2-ink)}',
      '.sa2-toast{position:fixed;left:50%;bottom:28px;z-index:100;transform:translateX(-50%);display:flex;align-items:center;gap:14px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:999px;background:var(--sa2-ink);color:var(--sa2-bg);font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.18);animation:sa2slide .3s var(--sa2-ease)}',
      '.sa2-toast button{flex:none;color:var(--sa2-bg);border-bottom:1px solid color-mix(in srgb,var(--sa2-bg) 50%,transparent);white-space:nowrap}',
      '.sa2-toast span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@container sa2 (max-width:700px){.sa2-inner{padding:48px 16px 90px}.sa2-tabs{left:-16px;right:-16px;padding:8px 16px}.sa2-h1{font-size:23px;line-height:32px}.sa2-say{padding-left:18px}.sa2-say input{font-size:14px}.sa2-send{height:40px;padding:0 18px}}',
      '@container sa2 (max-width:640px){.sa2-field{grid-template-columns:repeat(5,minmax(0,1fr))}.sa2-zone{padding:10px 4px;text-align:center}.sa2-zone-k{flex-direction:column;align-items:center;gap:0;font-size:11px;line-height:16px}.sa2-zone-k b{font-size:20px;line-height:26px}.sa2-marks,.sa2-peek{display:none}.sa2-hint{display:none}.sa2-sec{margin-top:32px}.sa2-row.is-wait{margin:0 -8px;padding-left:8px;padding-right:8px}}',
      '@container sa2 (max-width:560px){.sa2-say{flex-wrap:wrap;border-radius:20px;padding:10px 10px 10px 16px}.sa2-say input{flex:1 1 100%;height:36px}.sa2-chip{margin-left:2px}.sa2-send{margin-left:auto}.sa2-pending-head{flex-wrap:wrap}.sa2-pending-hint{flex-basis:100%;order:3;white-space:normal}.sa2-pending-go{order:2;margin-left:auto}.sa2-pending-main{flex-basis:100%}.sa2-pending-acts{width:100%;justify-content:flex-start;margin-left:0}.sa2-sheet{padding:22px 18px 60px}}',
      '@container sa2 (max-width:460px){.sa2-row{grid-template-columns:18px minmax(0,1fr);align-items:start}.sa2-acts{grid-column:2;justify-content:flex-start;margin-top:8px}.sa2-form{grid-column:2}.sa2-err{grid-column:2}.sa2-form{flex-wrap:wrap}.sa2-form input{flex-basis:100%}.sa2-asg{grid-template-columns:1fr}.sa2-asg .st{justify-self:start}}',
      '@media (max-width:640px){.sa2-sheet{width:100%;border-left:0}.sa2-pop{padding:12px}.sa2-toast{bottom:18px}}',
      '@media (max-width:460px){.sa2-row{grid-template-columns:18px minmax(0,1fr)}.sa2-acts{grid-column:2;justify-content:flex-start;margin-top:8px}.sa2-form,.sa2-err{grid-column:2}}',
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

    function Panel() {
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
        composerError: null,
        form: null,
        formText: '',
        rowError: null,
        busy: null,
        picker: null,
        routerOpen: false,
        quietDraft: null,
        rememberReject: false,
        ventsOpen: false,
        drawer: null,
        toast: null,
      })
      var S = state[0]
      var setS = state[1]
      var sectionRefs = React.useRef({})
      var fieldRef = React.useRef(null)

      function patch(next) {
        setS(function (prev) {
          var value = typeof next === 'function' ? next(prev) : next
          if (!value || value === prev) return prev
          return Object.assign({}, prev, value)
        })
      }

      function showToast(text, undoId) {
        patch({ toast: { text: text, undoId: undoId || null } })
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
            if (fromPicker && prev.picker) {
              return { busy: null, picker: Object.assign({}, prev.picker, { error: message }) }
            }
            return { busy: null, rowError: { id: id, message: message } }
          })
          return false
        }).catch(function (error) {
          var message = String((error && error.message) || error)
          patch(function () { return { busy: null, rowError: { id: id, message: message } } })
          return false
        })
      }

      function openPicker(target, id, mode) {
        patch({ picker: { target: target, id: id || null, mode: mode || 'workspace', other: false, path: '', error: null } })
      }

      function pick(path) {
        var picker = S.picker
        if (!picker) return
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
        patch({ busy: 'create', composerError: null })
        post(body).then(function (result) {
          if (result.ok) {
            var task = result.data && result.data.result && result.data.result.task
            var path = task && task.workspacePath
            var label = path ? wsLabel(path) : ''
            patch(function () {
              return {
                view: result.data,
                composer: '',
                busy: null,
                composerError: null,
                toast: {
                  text: label ? '记下了，在 ' + label + ' 里做' : '记下了，还没定在哪做',
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
        var copied = false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            var result = navigator.clipboard.writeText(sessionId)
            if (result && typeof result.then === 'function') {
              result.then(function () {
                showToast('会话编号已复制：' + sessionId, null)
              }).catch(function () {
                showToast('会话编号：' + sessionId, null)
              })
            } else {
              copied = true
            }
          }
        } catch (error) {
          copied = false
        }
        if (copied) showToast('会话编号已复制：' + sessionId, null)
        else if (!(typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function')) {
          showToast('会话编号：' + sessionId, null)
        }
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
        patch({ busy: 'notify', rowError: null })
        post({ action: action, text: String(text) }).then(function (result) {
          if (result.ok) {
            patch({ view: result.data, busy: null, quietDraft: null })
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
          return hh('code', { key: text, title: text }, text.split('/').pop() || text)
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
        if (!toast || !toast.undoId) {
          patch({ toast: null })
          return
        }
        post({ action: 'cancel', id: toast.undoId }).then(function (result) {
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

      function openForm(card, definition) {
        patch({
          form: {
            id: card.id,
            action: definition.action,
            label: definition.label,
          },
          formText: definition.preset || '',
          rememberReject: false,
          rowError: null,
        })
      }

      function doAction(card, definition) {
        if (definition.needsText) {
          openForm(card, definition)
          return
        }
        if (definition.action === 'start' && card.needsWorkspace) {
          openPicker('card', card.id, 'start')
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
            patch({ drawer: null })
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

      function renderAction(card, definition, index) {
        var key = (definition.action || 'a') + '-' + index + '-' + String(definition.label || '')
        return hh('button', {
          key: key,
          type: 'button',
          className: 'sa2-btn' + (definition.primary ? ' pri' : ''),
          disabled: S.busy === card.id,
          onClick: function () { doAction(card, definition) },
        }, definition.label)
      }

      function renderForm(card) {
        if (!S.form || S.form.id !== card.id) return null
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
          form.action === 'reject' && card.workspacePath
            ? hh('label', { className: 'sa2-checkline', style: { marginTop: 8, width: '100%' } },
                hh('input', {
                  type: 'checkbox', checked: S.rememberReject,
                  onChange: function (event) { patch({ rememberReject: event.target.checked }) },
                }),
                hh('span', null, '以后这个项目都按这条查'),
              )
            : null,
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
              event.stopPropagation()
              openPicker('card', card.id, 'workspace')
            },
          }, '在 ', hh('b', {}, card.workspaceLabel || wsLabel(card.workspacePath))))
        }
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
              card.rejectCount ? hh('span', { className: 'sa2-badge' }, '打回过 ' + card.rejectCount + ' 次') : null,
            ),
            card.reason ? hh('p', { className: 'sa2-why' }, card.reason) : null,
            card.checklist && card.checklist.length
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
                onClick: function () { openPicker('card', card.id, 'workspace') },
              }, '选目录'),
            ) : null,
            renderForm(card),
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
              hh('span', null, '下面 ' + manualCount + ' 张老卡 · 要你点开始')))
          }
          var badge = card.auto
            ? card.position ? '第 ' + card.position + ' 个' : '自动排队'
            : null
          out.push(renderRow(card, badge))
        })
        return out
      }

      function renderSection(key) {
        var list = (S.view && S.view.groups && S.view.groups[key]) || []
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
                  onClick: function () { patch({ routerOpen: true }) },
                }, modeToggle(router)),
              )
            : null,
          isQueued && S.rowError && S.rowError.id === 'router'
            ? hh('p', { className: 'sa2-err' }, S.rowError.message)
            : null,
          list.length
            ? hh('ul', { className: 'sa2-list' },
                isQueued ? renderQueuedRows(shown, manualCount) : shown.map(renderRow))
            : hh('p', { className: 'sa2-empty' }, META[key].empty),
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

      function renderZone(key) {
        var list = (S.view && S.view.groups && S.view.groups[key]) || []
        var marks = list.slice(0, 24).map(function (card, index) {
          return hh('span', { key: card.id + '-' + index, className: 'sa2-mk ' + markOf(card.stage) })
        })
        if (list.length > 24) marks.push(hh('span', { key: 'more', className: 'sa2-mk-more' }, '+' + (list.length - 24)))
        var peek = list.length ? list[0].title : META[key].empty
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
        return hh('div', { className: 'sa2-mini' + (S.scrolled ? ' on' : '') },
          hh('nav', { className: 'sa2-tabs', 'aria-label': '五组，滑到哪亮哪，点哪滑到哪' },
            GROUPS.map(function (key) {
              var count = ((S.view && S.view.counts && S.view.counts[key]) || 0)
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
        var selected = S.composerWorkspace
        var label = selected === null
          ? '先不定'
          : selected
            ? wsLabel(selected)
            : S.view && S.view.defaultWorkspace
              ? wsLabel(S.view.defaultWorkspace)
              : '先不定'
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
          hh('button', {
            type: 'button',
            className: 'sa2-chip',
            onClick: function () { openPicker('composer') },
            title: selected || (S.view && S.view.defaultWorkspace) || '先不定',
          }, '在哪做 · ', hh('b', null, label)),
          hh('button', {
            type: 'submit',
            className: 'sa2-send',
            disabled: S.busy === 'create' || !String(S.composer || '').trim(),
          }, '记下'),
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
        var modes = [
          { mode: 'off', label: '关' },
          { mode: 'observe', label: '观察' },
          { mode: 'auto', label: '自动' },
        ]
        return hh('div', {
          className: 'sa2-pop',
          onClick: function (event) {
            if (event.target === event.currentTarget) patch({ routerOpen: false })
          },
        },
          hh('div', { className: 'sa2-popcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': '自动开工' },
            hh('h3', null, '自动开工'),
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
                value: (S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }).from,
                disabled: S.busy === 'notify',
                style: { width: 88 },
                onChange: function (event) {
                  var q = S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }
                  patch({ quietDraft: { from: event.target.value, to: q.to } })
                },
              }),
              hh('span', null, '到'),
              hh('input', {
                type: 'time',
                value: (S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }).to,
                disabled: S.busy === 'notify',
                style: { width: 88 },
                onChange: function (event) {
                  var q = S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }
                  patch({ quietDraft: { from: q.from, to: event.target.value } })
                },
              }),
              hh('button', {
                type: 'button',
                className: 'sa2-link',
                disabled: S.busy === 'notify',
                onClick: function () {
                  var q = S.quietDraft || notify.quiet || { from: '23:00', to: '08:00' }
                  notifySet('notify_quiet', q.from + '-' + q.to)
                },
              }, '保存'),
            ),
            hh('p', { className: 'lead', style: { marginTop: 6 } },
              notify.lastError
                ? `上次没发出去：${notify.lastError}`
                : notify.status === 'unconfigured'
                  ? '还没配置发送方式'
                  : notify.status === 'off'
                    ? '通知关着'
                    : notify.configured
                      ? '已配置'
                      : '还没配置发送方式'),
            (function () {
              var rules = (S.view && S.view.acceptanceRules) || { count: 0, items: [] }
              return hh('div', { style: { marginTop: 16 } },
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
              )
            })(),
            hh('p', { className: 'lead', style: { marginTop: 18 } },
              '观察档只记「本来会开始」；自动档有空位就开工，手动点「开始」不受上限和同目录限制。'),
            hh('div', { className: 'sa2-pop-foot' },
              hh('span', { className: 'grow' }),
              hh('button', {
                type: 'button',
                className: 'sa2-link',
                onClick: function () { patch({ routerOpen: false }) },
              }, '关闭'),
            ),
          ),
        )
      }

      function renderPicker() {
        var picker = S.picker
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
        var rows = []
        if (detail) {
          rows.push(hh('p', { className: 'sa2-eyebrow', key: 'eyebrow' }, '卡片详情'))
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
                  execution.by === 'mcp' ? hh('span', { className: 'sa2-badge' }, '外部 Agent 交的') : null,
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
            if (event.target === event.currentTarget) patch({ drawer: null })
          },
        },
          hh('aside', { className: 'sa2-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': detail ? detail.title : '卡片详情' },
            hh('button', { type: 'button', className: 'x', onClick: function () { patch({ drawer: null }) } }, '关闭'),
            drawer.loading ? hh('p', { className: 'sa2-loading' }, '正在读这张卡…') : null,
            drawer.error ? hh('p', { className: 'sa2-err' }, drawer.error) : null,
            rows,
          ),
        )
      }

      function renderToast() {
        if (!S.toast) return null
        return hh('div', { className: 'sa2-toast', role: 'status' },
          hh('span', null, S.toast.text),
          S.toast.undoId
            ? hh('button', { type: 'button', onClick: undo }, '撤销')
            : null,
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
      var rest = '另外 ' + (counts.running || 0) + ' 件在跑，' + (counts.queued || 0) + ' 件排队。'

      return hh('div', { className: 'sa2' },
        hh('div', { className: 'sa2-inner' },
          hh('p', { className: 'sa2-eyebrow' }, 'SUPER AGENT', hh('span', { className: 'sa2-live' }, hh('i'), '本机台账')),
          hh('h1', { className: 'sa2-h1' },
            waiting
              ? [hh('b', { className: 'n', key: 'n' }, String(waiting)), ' 件事在等你。']
              : '现在没有事等你。',
            hh('span', { className: 'rest' }, rest),
          ),
          S.error ? hh('p', { className: 'sa2-banner' }, '读不到最新台账：' + S.error) : null,
          renderComposer(),
          S.composerError ? hh('p', { className: 'sa2-say-note' }, S.composerError) : null,
          hh('div', { className: 'sa2-field', role: 'navigation', 'aria-label': '全部事情，按轮到谁分', ref: fieldRef },
            GROUPS.map(renderZone),
          ),
          hh('p', { className: 'sa2-under' }, '往下滑就是全部。点一格直接跳到那一组；滑下去以后，这五格会收成顶上的一条页签。'),
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
      function bindUiWorkspace(service) {
        if (service && typeof service.openSession === 'function') {
          hostUi.openSession = id => service.openSession(id)
          hostUi.canOpen = true
        }
      }
      try {
        bindUiWorkspace(ctx.get && ctx.get('uiWorkspace', false))
      } catch (error) {
        // 服务还没挂上，等注入。
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
        }
      } catch (error) {
        // 没有 uiWorkspace 就用复制编号的退路。
      }
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
