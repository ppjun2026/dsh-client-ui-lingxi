/**
 * 灵犀（Lingxi）— 客户端入口。
 *
 * 零构建工具链：纯原生 DOM（无 React），模块以 window.__ModuleLoader__.load
 * 工厂形式注册。挂载两处：侧边栏入口按钮 + 中心列工作台面板。数据通过
 * fetch 调用 Host 的 /api/lingxi 路由（文件即真相，多标签页/对话通道共享）。
 *
 * 视图：灵感池（卡片墙）、关联图谱（Canvas 力导向）、项目（任务看板）。
 */

window.__ModuleLoader__.load({
  id: '@linxin666/dsh-client-ui-lingxi',
  factory: () => {
    'use strict'

    const API_PREFIX = '/api/lingxi'
    const PANEL_NAME = 'lingxi'

    // ── 常量 ────────────────────────────────────────────────────────────────
    const STATUS_META = {
      seed: { label: '灵感种子', color: 'var(--dsw-alias-label-tertiary)', hex: '#8b8b9e' },
      incubating: { label: '孵化中', color: 'var(--dsw-alias-state-business-primary)', hex: '#4aa3ff' },
      planning: { label: '计划中', color: 'var(--dsw-alias-state-warn-primary)', hex: '#ffb454' },
      project: { label: '已立项', color: 'var(--dsw-alias-state-success-primary)', hex: '#38d39f' },
      merged: { label: '已合并', color: 'var(--dsw-alias-label-dimmed)', hex: '#7a7a8a' },
      archived: { label: '已归档', color: 'var(--dsw-alias-label-dimmed)', hex: '#55555f' },
    }
    const STRENGTH_META = {
      high: { label: '强关联', color: 'var(--dsw-alias-state-error-primary)', hex: '#ff6b6b' },
      medium: { label: '中关联', color: 'var(--dsw-alias-state-warn-primary)', hex: '#ffb454' },
      low: { label: '弱关联', color: 'var(--dsw-alias-state-business-primary)', hex: '#6b8cff' },
    }
    const TASK_META = {
      todo: { label: '待办', color: 'var(--dsw-alias-label-tertiary)' },
      doing: { label: '进行中', color: 'var(--dsw-alias-state-business-primary)' },
      done: { label: '已完成', color: 'var(--dsw-alias-state-success-primary)' },
    }

    // ── 工具 ────────────────────────────────────────────────────────────────
    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function uuid() {
      return globalThis.crypto?.randomUUID?.() ?? `lx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    function fmtTime(ms) {
      if (!Number.isFinite(ms)) return ''
      const d = new Date(ms)
      const pad = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function scoreColor(score) {
      if (score >= 75) return 'var(--dsw-alias-state-success-primary)'
      if (score >= 50) return 'var(--dsw-alias-state-warn-primary)'
      if (score > 0) return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-label-tertiary)'
    }

    function hexToRgba(hex, alpha) {
      const h = String(hex || '#8b8b9e').replace('#', '')
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${alpha})`
    }

    function readCssVar(name, fallback) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name)
      return value && value.trim() !== '' ? value.trim() : fallback
    }

    // ── 数据层 ──────────────────────────────────────────────────────────────
    async function fetchState() {
      const res = await fetch(`${API_PREFIX}/state`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`读取状态失败：${res.status}`)
      return await res.json()
    }

    async function postAction(action) {
      const res = await fetch(`${API_PREFIX}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `操作失败：${res.status}`)
      return body
    }

    // ── UI 状态 ─────────────────────────────────────────────────────────────
    const ui = {
      open: false,
      view: 'pool', // pool | graph | projects
      data: { schemaVersion: 1, revision: 0, ideas: [], projects: [], merges: [] },
      selectedId: null,
      search: '',
      statusFilter: 'all',
      tagFilter: 'all',
      domainFilter: 'all',
      loading: false,
      error: '',
    }
    const listeners = new Set()

    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    function emit() {
      for (const fn of [...listeners]) fn()
    }

    function setUI(patch) {
      Object.assign(ui, patch)
      emit()
    }

    function allTags() {
      const set = new Set()
      for (const idea of ui.data.ideas) {
        for (const tag of idea.tags || []) set.add(tag)
      }
      return [...set].sort()
    }

    function allDomains() {
      const set = new Set()
      for (const idea of ui.data.ideas) {
        if (idea.domain) set.add(idea.domain)
      }
      return [...set].sort()
    }

    async function reload() {
      ui.loading = true
      emit()
      try {
        ui.data = await fetchState()
        ui.error = ''
      } catch (error) {
        ui.error = error instanceof Error ? error.message : String(error)
      } finally {
        ui.loading = false
        emit()
      }
    }

    async function doAction(action) {
      ui.loading = true
      ui.error = ''
      // 注意：请求期间不 emit——不能在事件回调（select change / button click）里
      // 同步重建 DOM，否则正在交互的元素被销毁会导致浏览器崩溃（闪退）。
      // 只在请求完成后 emit 一次。
      try {
        ui.data = await postAction(action)
      } catch (error) {
        ui.error = error instanceof Error ? error.message : String(error)
      } finally {
        ui.loading = false
        // 延迟到下一帧再刷新：给浏览器时间完成 select 等原生控件的事件清理，
        // 避免在交互元素上重建 DOM 导致崩溃。
        requestAnimationFrame(() => emit())
      }
    }

    // ── CSS ──────────────────────────────────────────────────────────────────
    const CSS = `
      /* 侧边栏入口（与任务看板同款） */
      .lx-entry {
        display: flex; align-items: center; gap: 8px;
        width: 100%; height: 32px; padding: 0 12px;
        background: transparent; border: none; border-radius: 8px;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer; font-size: 13px; white-space: nowrap;
      }
      .lx-entry:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-primary); }
      .lx-entry[data-active] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
      .lx-entryIcon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
      .lx-entryLabel { overflow: hidden; text-overflow: ellipsis; }
      [data-dsh-frame][data-sidebar-collapsed] .lx-entry { justify-content: center; padding: 0; width: 100%; }
      [data-dsh-frame][data-sidebar-collapsed] .lx-entryLabel { display: none; }

      /* 中心列接管 */
      [data-pane='conversation'],
      [class*='centerCol'] { position: relative; }
      [data-dsh-lingxi-view] {
        position: absolute; inset: 0; display: none; z-index: 60; flex-direction: column;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        overflow: hidden; font-family: var(--dsw-font-family); font-size: 13px; line-height: 1.55;
      }
      html[data-dsh-lingxi-active]:not([data-dsh-ssh-active]) [data-dsh-lingxi-view] { display: flex; }
      html[data-dsh-lingxi-active]:not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([data-dsh-lingxi-view]),
      html[data-dsh-lingxi-active]:not([data-dsh-ssh-active]) [class*='centerCol'] > :not([data-dsh-lingxi-view]) { display: none !important; }
      [data-dsh-lingxi-view] * { box-sizing: border-box; }

      /* 头部 */
      .lx-header { display: flex; align-items: center; gap: 16px; padding: 20px 24px 16px; flex: none; }
      .lx-header-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .lx-title { font-weight: 650; font-size: 17px; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
      .lx-sub { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
      .lx-tabs { display: flex; gap: 2px; margin-left: auto; flex: none; }
      .lx-tab {
        padding: 7px 13px; border: none; border-radius: 8px; background: none;
        color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 13px; font-weight: 500;
        transition: color 120ms, background 120ms;
      }
      .lx-tab:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
      .lx-tab.active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }

      /* 工具栏 */
      .lx-toolbar { display: flex; align-items: center; gap: 8px; padding: 0 24px 8px; flex: none; flex-wrap: wrap; }
      .lx-search {
        flex: 0 1 240px; min-width: 140px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px; color: var(--dsw-alias-label-primary); padding: 7px 12px;
        font-size: 12.5px; outline: none; font-family: inherit;
      }
      .lx-search::placeholder { color: var(--dsw-alias-label-tertiary); }
      .lx-search:focus { border-color: var(--dsw-alias-state-business-primary); }
      .lx-chip {
        padding: 4px 11px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
        font-size: 11.5px; font-family: inherit; white-space: nowrap;
        transition: color 120ms, border-color 120ms, background 120ms;
      }
      .lx-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .lx-chip.active {
        background: var(--dsw-alias-state-business-primary);
        border-color: var(--dsw-alias-state-business-primary);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .lx-filter-label {
        flex: none; font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
        color: var(--dsw-alias-label-tertiary); padding-right: 2px;
      }
      .lx-chip-domain { border-radius: 6px; }
      .lx-chip-domain.active {
        background: var(--dsw-alias-interactive-bg-active);
        border-color: var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-primary);
      }

      /* 按钮 */
      .lx-btn {
        padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
        background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer;
        font-size: 12.5px; font-weight: 500; white-space: nowrap; font-family: inherit;
        transition: background 120ms, border-color 120ms;
      }
      .lx-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .lx-btn.primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      .lx-btn.primary:hover { background: var(--dsw-alias-button-primary-hover); }
      .lx-btn.danger { color: var(--dsw-alias-state-error-primary); }
      .lx-btn.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }

      /* 主体 */
      .lx-body { flex: 1; overflow: auto; padding: 6px 24px 24px; }
      .lx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
      .lx-card {
        position: relative;
        display: flex; flex-direction: column; gap: 12px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px; padding: 18px 18px 18px 22px; cursor: pointer; overflow: hidden;
        transition: border-color 140ms ease, transform 140ms ease;
      }
      .lx-card::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
        background: var(--lx-status-color, var(--dsw-alias-label-tertiary)); opacity: 0.9;
      }
      .lx-card:hover { border-color: var(--dsw-alias-border-l2); transform: translateY(-2px); }
      .lx-card-title { font-weight: 600; font-size: 15px; line-height: 1.4; color: var(--dsw-alias-label-primary); }
      .lx-card-raw {
        color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.5;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .lx-card-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .lx-score { font-weight: 650; font-size: 12.5px; }
      .lx-tag {
        font-size: 11px; padding: 2px 8px; border-radius: 6px;
        background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary);
      }
      .lx-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
      .lx-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
      .lx-rel { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

      /* 空态 / 错误 */
      .lx-empty { color: var(--dsw-alias-label-tertiary); text-align: center; padding: 72px 24px; font-size: 13px; }
      .lx-error { color: var(--dsw-alias-state-error-primary); padding: 8px 24px; font-size: 12px; flex: none; }

      /* 详情弹层 */
      .lx-overlay { position: absolute; inset: 0; z-index: 20; background: var(--dsw-alias-bg-mask-1); display: flex; align-items: center; justify-content: center; }
      .lx-modal {
        display: flex; flex-direction: column; width: min(660px, 92%); max-height: 86%;
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 14px; overflow: hidden;
      }
      .lx-modal-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
      .lx-modal-head .lx-title { flex: 1; font-size: 15px; }
      .lx-modal-body { flex: 1; overflow: auto; padding: 20px; }
      .lx-section { margin-bottom: 20px; }
      .lx-section-h { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); margin-bottom: 8px; }
      .lx-section .lx-text { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .lx-scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
      .lx-score-box { display: flex; flex-direction: column; align-items: center; gap: 2px; background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 12px 8px; }
      .lx-score-box .n { font-size: 20px; font-weight: 650; line-height: 1; }
      .lx-score-box .l { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .lx-note { background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; font-size: 12.5px; line-height: 1.5; }
      .lx-note .t { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; margin-top: 3px; }
      .lx-rel-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); margin-bottom: 6px; cursor: pointer; transition: background 120ms; }
      .lx-rel-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .lx-rel-strength { font-size: 10.5px; font-weight: 600; white-space: nowrap; }

      /* 输入框 */
      .lx-input {
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px; color: var(--dsw-alias-label-primary); padding: 7px 12px;
        font-size: 12.5px; outline: none; font-family: inherit;
      }
      .lx-input:focus { border-color: var(--dsw-alias-state-business-primary); }
      select.lx-input { cursor: pointer; }

      /* 项目看板 */
      .lx-project { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
      .lx-project-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
      .lx-project-title { flex: 1; min-width: 0; }
      .lx-project-name { font-weight: 650; font-size: 15px; color: var(--dsw-alias-label-primary); }
      .lx-project-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
      .lx-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; flex: none;
        background: transparent; border: none; border-radius: 6px;
        color: var(--dsw-alias-label-tertiary); cursor: pointer;
        transition: background 120ms, color 120ms;
      }
      .lx-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
      .lx-delete.confirming {
        background: var(--dsw-alias-state-error-primary); color: #fff;
        width: auto; padding: 4px 10px; font-size: 12px; font-weight: 600; border-radius: 6px;
      }
      .lx-delete.confirming:hover { background: var(--dsw-alias-state-error-primary); color: #fff; }
      .lx-progress { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .lx-progress-track { flex: 1; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
      .lx-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); transition: width 300ms ease; }
      .lx-progress-label { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); min-width: 36px; text-align: right; }
      .lx-project-goal { font-size: 12.5px; color: var(--dsw-alias-label-secondary); line-height: 1.55; margin-bottom: 12px; }
      .lx-kanban { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
      .lx-col { background: var(--dsw-alias-bg-base); border-radius: 10px; padding: 10px; min-height: 120px; }
      .lx-col-h { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); margin-bottom: 8px; }
      .lx-task { display: flex; align-items: center; gap: 8px; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; font-size: 12.5px; }
      .lx-task select { background: transparent; border: none; color: inherit; font-size: 11px; cursor: pointer; }
      .lx-task-del {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; padding: 0; flex: none;
        background: transparent; border: none; border-radius: 4px;
        color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 13px; line-height: 1;
        transition: background 120ms, color 120ms;
      }
      .lx-task-del:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-error-primary); }
      .lx-task-del.confirming {
        background: var(--dsw-alias-state-error-primary); color: #fff;
        width: auto; padding: 0 6px; font-size: 10.5px; font-weight: 600;
      }
      .lx-task-del.confirming:hover { background: var(--dsw-alias-state-error-primary); color: #fff; }

      /* 图谱 */
      .lx-graph-wrap { position: relative; height: 100%; min-height: 400px; overflow: hidden; }
      .lx-graph-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: default; }
      .lx-hint { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; margin-top: 4px; }
      .lx-graph-legend {
        position: absolute; top: 12px; right: 12px; z-index: 5;
        display: flex; flex-direction: column; gap: 4px;
        padding: 10px 12px; border-radius: 10px;
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
        pointer-events: none;
      }
      .lx-graph-legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .lx-graph-legend-divider { height: 1px; margin: 2px 0; background: var(--dsw-alias-border-l1); }
      .lx-legend-edge { width: 16px; height: 3px; border-radius: 2px; flex: none; }
      .lx-graph-hint {
        position: absolute; left: 12px; bottom: 10px; z-index: 5;
        font-size: 11px; color: var(--dsw-alias-label-tertiary); pointer-events: none;
      }
      .lx-graph-tip {
        position: absolute; z-index: 8; min-width: 160px; max-width: 240px;
        padding: 10px 12px; border-radius: 10px;
        background: var(--dsw-hovercard-bg, var(--dsw-alias-bg-base));
        border: 1px solid var(--dsw-alias-border-l2);
        box-shadow: var(--dsw-shadow-lv3, none);
        pointer-events: none;
      }
      .lx-graph-tip-title { font-weight: 600; font-size: 12.5px; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
      .lx-graph-tip-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .lx-graph-tip-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    `

    // ── 侧边栏入口 ──────────────────────────────────────────────────────────
    function mountSidebarEntry() {
      const ROW_ATTR = 'data-dsh-lingxi-entry'
      const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M5.5 4.5h5M5.5 8h5M5.5 11.5h3"/></svg>'

      if (document.querySelector(`[${ROW_ATTR}]`) !== null) return () => {}

      const entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute(ROW_ATTR, '')
      entry.setAttribute('data-dsh-plugin', 'lingxi')
      entry.setAttribute('data-dsh-part', 'sidebar-entry')
      entry.setAttribute('aria-label', '灵犀 · 灵感工作台')
      entry.setAttribute('title', '灵犀 · 灵感工作台')
      entry.className = 'lx-entry'
      entry.innerHTML = `<span class="lx-entryIcon">${ICON}</span><span class="lx-entryLabel">灵犀</span>`
      entry.addEventListener('click', () => { toggleOpen() })

      function sidebarRoot() {
        const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
        if (column === null) return undefined
        const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
        return logoOwner ?? column.firstElementChild
      }

      let root
      let placed = false
      let rootObserver

      function tryPlace() {
        if (root !== undefined && !root.isConnected) {
          rootObserver?.disconnect()
          root = undefined
          placed = false
        }
        if (placed) {
          if (document.body.contains(entry)) return
          rootObserver?.disconnect()
          root = undefined
          placed = false
        }
        root ??= sidebarRoot()
        if (root === undefined) return
        if (entry.parentElement !== root) {
          const button = root.querySelector('button[class*="newSession"]')
          if (button === undefined) return
          const row = button.closest('[class*="logoRow"]')
          const base = (row !== null && row.parentElement === root) ? row : button
          root.insertBefore(entry, base.nextElementSibling)
        }
        placed = true
        if (rootObserver === undefined) {
          rootObserver = new MutationObserver(() => {
            if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return }
            if (!root.contains(entry)) { placed = false; tryPlace() }
          })
          rootObserver.observe(root, { childList: true, subtree: true })
        }
      }

      const waitObserver = new MutationObserver(() => { tryPlace() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      const syncActive = () => {
        if (ui.open) entry.dataset.active = 'true'
        else delete entry.dataset.active
      }
      const unsub = subscribe(syncActive)
      syncActive()
      tryPlace()

      return () => {
        waitObserver.disconnect()
        rootObserver?.disconnect()
        unsub()
        entry.remove()
      }
    }

    function toggleOpen() {
      if (!ui.open) {
        ui.open = true
        document.documentElement.removeAttribute('data-dsh-ssh-active')
        document.documentElement.removeAttribute('data-dsh-taskboard-active')
        document.documentElement.setAttribute('data-dsh-lingxi-active', '')
        document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: PANEL_NAME }))
        reload()
      } else {
        ui.open = false
        document.documentElement.removeAttribute('data-dsh-lingxi-active')
      }
      emit()
    }

    function closePanel() {
      if (!ui.open) return
      ui.open = false
      document.documentElement.removeAttribute('data-dsh-lingxi-active')
      emit()
    }

    // ── 面板挂载 ────────────────────────────────────────────────────────────
    let panelEl
    let renderUnsub
    let graphInstance = null

    function disposeGraph() {
      if (graphInstance !== null) {
        try { graphInstance.disposer() } catch { /* noop */ }
        graphInstance = null
      }
    }

    function mountPanel() {
      if (panelEl !== undefined) return () => {}
      let container

      function ensure() {
        if (container !== undefined) return
        const column = document.querySelector('[data-pane="conversation"], [class*="centerCol"]')
        if (column === null) return
        container = document.createElement('div')
        container.setAttribute('data-dsh-lingxi-view', '')
        column.appendChild(container)

        const style = document.createElement('style')
        style.setAttribute('data-dsh-lingxi-style', '')
        style.textContent = CSS
        document.head.appendChild(style)

        container.innerHTML = buildPanelHTML()
        bindPanelEvents(container)
        renderUnsub = subscribe(() => { render(container) })
        applyOpen()
      }

      const waitObserver = new MutationObserver(() => { ensure() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      const applyOpen = () => {
        if (ui.open && container !== undefined) render(container)
      }
      subscribe(applyOpen)
      ensure()

      return () => {
        waitObserver.disconnect()
        renderUnsub?.()
        disposeGraph()
        document.querySelector('[data-dsh-lingxi-style]')?.remove()
        container?.remove()
        container = undefined
        panelEl = undefined
      }
    }

    // ── 面板 HTML 骨架 ──────────────────────────────────────────────────────
    function buildPanelHTML() {
      return `
        <div class="lx-header">
          <div class="lx-header-titles">
            <div class="lx-title">灵犀 · 灵感工作台</div>
            <div class="lx-sub">碎片想法 → 孵化 → 计划 → 立项</div>
          </div>
          <div class="lx-tabs">
            <button class="lx-tab" data-view="pool">灵感池</button>
            <button class="lx-tab" data-view="graph">关联图谱</button>
            <button class="lx-tab" data-view="projects">项目</button>
          </div>
        </div>
        <div class="lx-toolbar">
          <input class="lx-search" placeholder="搜索想法…" data-role="search">
          <div data-role="status-filters"></div>
        </div>
        <div class="lx-toolbar" data-role="tag-filters" style="padding-top:0"></div>
        <div class="lx-toolbar" data-role="domain-filters" style="padding-top:0"></div>
        <div class="lx-error" data-role="error" style="display:none"></div>
        <div class="lx-body" data-role="body"></div>
        <div data-role="overlay"></div>
      `
    }

    // ── 渲染 ────────────────────────────────────────────────────────────────
    function render(container) {
      // tabs
      container.querySelectorAll('.lx-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === ui.view)
      })
      // search（保留输入焦点，仅在失焦时回填）
      const searchInput = container.querySelector('[data-role="search"]')
      if (searchInput && document.activeElement !== searchInput) {
        searchInput.value = ui.search
      }
      // status filters
      renderStatusFilters(container)
      renderTagFilters(container)
      renderDomainFilters(container)
      // error
      const errEl = container.querySelector('[data-role="error"]')
      if (errEl) {
        errEl.style.display = ui.error ? 'block' : 'none'
        errEl.textContent = ui.error
      }
      // body
      const body = container.querySelector('[data-role="body"]')
      if (body) {
        if (ui.loading) { disposeGraph(); body.innerHTML = '<div class="lx-empty">加载中…</div>' }
        else if (ui.view === 'pool') { disposeGraph(); body.innerHTML = renderPool() }
        else if (ui.view === 'graph') {
          const ideas = filteredIdeas()
          if (ideas.length === 0) {
            disposeGraph()
            body.innerHTML = '<div class="lx-empty">没有可展示的想法。</div>'
          } else {
            const signature = `${ui.data.revision}|${ui.search}|${ui.statusFilter}|${ui.tagFilter}|${ui.domainFilter}`
            const existing = body.querySelector('.lx-graph-wrap')
            if (existing === null || graphInstance === null || graphInstance.signature !== signature) {
              body.innerHTML = renderGraphWrap()
              disposeGraph()
              const canvas = body.querySelector('canvas.lx-graph-canvas')
              graphInstance = {
                signature,
                disposer: createGraph(canvas, ideas, (id) => { setUI({ selectedId: id }) }),
              }
            }
          }
        }
        else if (ui.view === 'projects') { disposeGraph(); body.innerHTML = renderProjects() }
      }
      // overlay (detail)
      const overlay = container.querySelector('[data-role="overlay"]')
      if (overlay) {
        overlay.innerHTML = ui.selectedId ? renderDetail(ui.selectedId) : ''
      }
    }

    function renderStatusFilters(container) {
      const wrap = container.querySelector('[data-role="status-filters"]')
      if (!wrap) return
      const statuses = [['all', '全部'], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label])]
      wrap.innerHTML = statuses.map(([k, label]) =>
        `<button class="lx-chip ${ui.statusFilter === k ? 'active' : ''}" data-action="filter-status" data-status="${k}">${label}</button>`
      ).join('')
    }

    function renderTagFilters(container) {
      const wrap = container.querySelector('[data-role="tag-filters"]')
      if (!wrap) return
      const tags = allTags()
      if (tags.length === 0) { wrap.innerHTML = ''; return }
      const label = `<span class="lx-filter-label">共性</span>`
      const chips = [`<button class="lx-chip ${ui.tagFilter === 'all' ? 'active' : ''}" data-action="filter-tag" data-tag="all">全部</button>`]
      for (const tag of tags) {
        chips.push(`<button class="lx-chip ${ui.tagFilter === tag ? 'active' : ''}" data-action="filter-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`)
      }
      wrap.innerHTML = label + chips.join('')
    }

    function renderDomainFilters(container) {
      const wrap = container.querySelector('[data-role="domain-filters"]')
      if (!wrap) return
      const domains = allDomains()
      if (domains.length === 0) { wrap.innerHTML = ''; return }
      const label = `<span class="lx-filter-label">领域</span>`
      const chips = [`<button class="lx-chip lx-chip-domain ${ui.domainFilter === 'all' ? 'active' : ''}" data-action="filter-domain" data-domain="all">全部</button>`]
      for (const d of domains) {
        chips.push(`<button class="lx-chip lx-chip-domain ${ui.domainFilter === d ? 'active' : ''}" data-action="filter-domain" data-domain="${escapeHtml(d)}">${escapeHtml(d)}</button>`)
      }
      wrap.innerHTML = label + chips.join('')
    }

    function filteredIdeas() {
      let list = ui.data.ideas
      if (ui.statusFilter !== 'all') list = list.filter(i => i.status === ui.statusFilter)
      if (ui.tagFilter !== 'all') list = list.filter(i => (i.tags || []).includes(ui.tagFilter))
      if (ui.domainFilter !== 'all') list = list.filter(i => i.domain === ui.domainFilter)
      const q = ui.search.trim().toLowerCase()
      if (q !== '') {
        list = list.filter(i =>
          (i.title || '').toLowerCase().includes(q)
          || (i.raw || '').toLowerCase().includes(q)
          || (i.analysis || '').toLowerCase().includes(q)
          || (i.tags || []).some(t => t.toLowerCase().includes(q))
        )
      }
      return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    }

    function renderPool() {
      const ideas = filteredIdeas()
      if (ideas.length === 0) {
        return `<div class="lx-empty">${ui.data.ideas.length === 0 ? '池子还是空的 — 在对话里对我说一个想法，即可自动入池。' : '没有符合条件的想法。'}</div>`
      }
      return `<div class="lx-grid">${ideas.map(idea => renderCard(idea)).join('')}</div>`
    }

    function renderCard(idea) {
      const status = STATUS_META[idea.status] || STATUS_META.seed
      const overall = idea.scores?.overall || 0
      const scoreHtml = overall > 0
        ? `<span class="lx-score" style="color:${scoreColor(overall)}">${overall}</span>`
        : ''
      const tagsHtml = (idea.tags || []).slice(0, 4).map(t => `<span class="lx-tag">${escapeHtml(t)}</span>`).join('')
      const relCount = (idea.related || []).length
      const mergedMark = idea.status === 'merged' ? ' · 已并入' : ''
      return `
        <div class="lx-card" data-action="open-idea" data-id="${escapeHtml(idea.id)}" style="--lx-status-color:${status.color}">
          <div class="lx-card-title">${escapeHtml(idea.title || idea.raw.slice(0, 40) || '(无标题)')}${mergedMark}</div>
          <div class="lx-card-raw">${escapeHtml(idea.raw)}</div>
          <div class="lx-card-meta">
            <span class="lx-status"><span class="lx-dot" style="background:${status.color}"></span>${status.label}</span>
            ${scoreHtml}
            ${relCount > 0 ? `<span class="lx-rel">↔ ${relCount}</span>` : ''}
          </div>
          ${tagsHtml ? `<div class="lx-card-meta">${tagsHtml}</div>` : ''}
        </div>`
    }

    function renderDetail(ideaId) {
      const idea = ui.data.ideas.find(i => i.id === ideaId)
      if (idea === undefined) return ''
      const status = STATUS_META[idea.status] || STATUS_META.seed
      const s = idea.scores || {}
      const related = (idea.related || []).map(r => {
        const target = ui.data.ideas.find(i => i.id === r.ideaId)
        const label = target ? (target.title || target.raw.slice(0, 20)) : '(已删除)'
        const strength = STRENGTH_META[r.strength] || STRENGTH_META.medium
        return `<div class="lx-rel-item" data-action="open-idea" data-id="${escapeHtml(r.ideaId)}">
          <span class="lx-rel-strength" style="color:${strength.color}">${strength.label}</span>
          <span style="color:var(--dsw-alias-label-primary)">${escapeHtml(label)}</span>
          ${r.reason ? `<span style="color:var(--dsw-alias-label-tertiary);font-size:11px">${escapeHtml(r.reason)}</span>` : ''}
        </div>`
      }).join('')
      const notes = (idea.notes || []).map(n =>
        `<div class="lx-note"><div>${escapeHtml(n.text)}</div><div class="t">${fmtTime(n.createdAt)}</div></div>`
      ).join('')
      const mergedInfo = idea.mergedInto
        ? `<div class="lx-hint">此想法已合并入：${escapeHtml(ui.data.ideas.find(i => i.id === idea.mergedInto)?.title || idea.mergedInto)}</div>`
        : ''

      return `
        <div class="lx-overlay" data-action="close-detail">
          <div class="lx-modal" data-stop="true">
            <div class="lx-modal-head">
              <span class="lx-status"><span class="lx-dot" style="background:${status.color}"></span>${status.label}</span>
              <div class="lx-title">${escapeHtml(idea.title || '(无标题)')}</div>
              <button class="lx-btn" data-action="close-detail">关闭</button>
            </div>
            <div class="lx-modal-body">
              <div class="lx-section">
                <div class="lx-section-h">原始想法</div>
                <div class="lx-text">${escapeHtml(idea.raw) || '<span class="lx-hint" style="margin:0">(空)</span>'}</div>
              </div>
              <div class="lx-section">
                <div class="lx-section-h">AI 评分</div>
                <div class="lx-scores">
                  <div class="lx-score-box"><div class="n" style="color:${scoreColor(s.novelty || 0)}">${s.novelty || 0}</div><div class="l">新颖性</div></div>
                  <div class="lx-score-box"><div class="n" style="color:${scoreColor(s.feasibility || 0)}">${s.feasibility || 0}</div><div class="l">可行性</div></div>
                  <div class="lx-score-box"><div class="n" style="color:${scoreColor(s.value || 0)}">${s.value || 0}</div><div class="l">价值潜力</div></div>
                  <div class="lx-score-box"><div class="n" style="color:${scoreColor(s.overall || 0)}">${s.overall || 0}</div><div class="l">综合</div></div>
                </div>
              </div>
              <div class="lx-section">
                <div class="lx-section-h">AI 解析</div>
                <div class="lx-text">${escapeHtml(idea.analysis) || '<span class="lx-hint" style="margin:0">尚未解析 — 在对话里让我「解析这个想法」即可。</span>'}</div>
              </div>
              <div class="lx-section">
                <div class="lx-section-h">标签 · 领域</div>
                <div class="lx-card-meta">
                  ${(idea.tags || []).map(t => `<span class="lx-tag">${escapeHtml(t)}</span>`).join('')}
                  ${idea.domain ? `<span class="lx-tag">${escapeHtml(idea.domain)}</span>` : ''}
                </div>
              </div>
              ${related ? `<div class="lx-section"><div class="lx-section-h">关联想法（${(idea.related || []).length}）</div>${related}</div>` : ''}
              <div class="lx-section">
                <div class="lx-section-h">深入构想记录（${(idea.notes || []).length}）</div>
                ${notes || '<span class="lx-hint" style="margin:0">还没有构想记录。</span>'}
                <div style="display:flex;gap:8px;margin-top:8px">
                  <input class="lx-input" style="flex:1" placeholder="补充一条构想…" data-role="note-input">
                  <button class="lx-btn primary" data-action="add-note" data-id="${escapeHtml(idea.id)}">添加</button>
                </div>
              </div>
              <div class="lx-section">
                <div class="lx-section-h">操作</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <select class="lx-input" data-role="status-select" data-id="${escapeHtml(idea.id)}">
                    ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${idea.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                  </select>
                  <button class="lx-btn" data-action="promote-project" data-id="${escapeHtml(idea.id)}">立项为项目</button>
                  <button class="lx-btn" data-action="merge-prompt" data-id="${escapeHtml(idea.id)}">合并到…</button>
                  <button class="lx-btn danger" data-action="delete-idea" data-id="${escapeHtml(idea.id)}">删除</button>
                </div>
                ${mergedInfo}
                <div class="lx-hint" style="margin-top:8px">提示：AI 解析、评分、标签、关联检测与合并建议，请在对话里对我发起。</div>
              </div>
            </div>
          </div>
        </div>`
    }

    function renderProjects() {
      const projects = ui.data.projects
      if (projects.length === 0) {
        return `<div class="lx-empty">还没有项目。在想法详情里点「立项为项目」，即可把孵化成熟的想法转成项目。</div>`
      }
      const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4M4 4l.6 8.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8L12 4"/></svg>'
      return projects.map(p => {
        const idea = ui.data.ideas.find(i => i.id === p.ideaId)
        const tasks = p.tasks || []
        const doneCount = tasks.filter(t => t.status === 'done').length
        const pct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0
        const cols = ['todo', 'doing', 'done'].map(status => {
          const list = tasks.filter(t => t.status === status)
          const meta = TASK_META[status]
          return `<div class="lx-col">
            <div class="lx-col-h" style="color:${meta.color}">${meta.label}（${list.length}）</div>
            ${list.map(t => `<div class="lx-task">
              <span style="flex:1">${escapeHtml(t.title)}</span>
              <select class="lx-task-status" data-action="task-status" data-project="${escapeHtml(p.id)}" data-task="${escapeHtml(t.id)}">
                ${Object.entries(TASK_META).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
              </select>
              <button class="lx-task-del" data-action="delete-task" data-project="${escapeHtml(p.id)}" data-task="${escapeHtml(t.id)}" title="删除任务">×</button>
            </div>`).join('')}
            <div style="display:flex;gap:6px;margin-top:6px">
              <input class="lx-input" style="flex:1;width:100%" placeholder="新任务…" data-role="task-input" data-project="${escapeHtml(p.id)}" data-status="${status}">
            </div>
          </div>`
        }).join('')
        return `<div class="lx-project">
          <div class="lx-project-head">
            <div class="lx-project-title">
              <div class="lx-project-name">${escapeHtml(p.name)}</div>
              <div class="lx-project-meta">
                ${idea ? `<span class="lx-status"><span class="lx-dot" style="background:var(--dsw-alias-state-success-primary)"></span>${escapeHtml(idea.title || idea.raw.slice(0, 16))}</span>` : ''}
                <span>创建于 ${fmtTime(p.createdAt)}</span>
                <span>${doneCount}/${tasks.length} 任务</span>
              </div>
            </div>
            <button class="lx-icon-btn lx-delete" data-action="delete-project" data-project="${escapeHtml(p.id)}" title="删除项目">${TRASH_ICON}</button>
          </div>
          ${tasks.length > 0 ? `<div class="lx-progress">
            <div class="lx-progress-track"><div class="lx-progress-fill" style="width:${pct}%"></div></div>
            <span class="lx-progress-label">${pct}%</span>
          </div>` : ''}
          ${p.goal ? `<div class="lx-project-goal">${escapeHtml(p.goal)}</div>` : ''}
          <div class="lx-kanban">${cols}</div>
        </div>`
      }).join('')
    }

    // ── 图谱 ────────────────────────────────────────────────────────────────
    function renderGraphWrap() {
      const statusLegend = Object.values(STATUS_META).map(s =>
        `<div class="lx-graph-legend-item"><span class="lx-dot" style="background:${s.hex}"></span>${s.label}</div>`
      ).join('')
      const strengthLegend = Object.values(STRENGTH_META).map(s =>
        `<div class="lx-graph-legend-item"><span class="lx-legend-edge" style="background:${s.hex}"></span>${s.label}</div>`
      ).join('')
      return `<div class="lx-graph-wrap">
        <canvas class="lx-graph-canvas"></canvas>
        <div class="lx-graph-legend">${statusLegend}<div class="lx-graph-legend-divider"></div>${strengthLegend}</div>
        <div class="lx-graph-hint">滚轮缩放 · 拖拽节点 · 拖拽空白平移 · 悬停高亮 · 点击看详情</div>
      </div>`
    }

    function createGraph(canvas, ideas, onSelect) {
      // ── 构建节点与边 ──
      const byId = new Map(ideas.map(i => [i.id, i]))
      const nodes = ideas.map((i, idx) => ({
        id: i.id,
        idx,
        title: i.title || i.raw.slice(0, 16) || '(无标题)',
        overall: i.scores?.overall || 0,
        status: i.status,
        hex: (STATUS_META[i.status] || STATUS_META.seed).hex,
        x: 0, y: 0, vx: 0, vy: 0,
      }))
      const nodeIndex = new Map(nodes.map(n => [n.id, n.idx]))
      const edges = []
      const seen = new Set()
      for (const idea of ideas) {
        for (const r of idea.related || []) {
          if (!byId.has(r.ideaId)) continue
          const a = nodeIndex.get(idea.id)
          const b = nodeIndex.get(r.ideaId)
          if (a === undefined || b === undefined || a === b) continue
          const key = a < b ? `${a}-${b}` : `${b}-${a}`
          if (seen.has(key)) continue
          seen.add(key)
          edges.push({ a, b, strength: r.strength || 'medium', hex: (STRENGTH_META[r.strength] || STRENGTH_META.medium).hex })
        }
      }

      const wrap = canvas.parentElement
      const dpr = window.devicePixelRatio || 1

      // ── 初始圆形分布 ──
      let width = wrap.clientWidth || 600
      let height = wrap.clientHeight || 440
      const cx0 = width / 2
      const cy0 = height / 2
      const initRadius = Math.min(width, height) * 0.38
      nodes.forEach((n, i) => {
        const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2
        n.x = cx0 + Math.cos(angle) * initRadius
        n.y = cy0 + Math.sin(angle) * initRadius
      })

      const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 1.35

      // ── 交互状态 ──
      let hoverIdx = -1
      let dragIdx = -1
      let selectedId = null
      let pan = { x: 0, y: 0 }
      let zoom = 1
      let panning = false
      let panStart = { x: 0, y: 0, px: 0, py: 0 }
      let moved = false

      // 主题色缓存（只读一次，避免每帧 getComputedStyle）
      const labelColor = readCssVar('--dsw-alias-label-primary', '#e6e6ee')
      const dimColor = readCssVar('--dsw-alias-label-tertiary', '#8b8b9e')

      // ── 动画调度（收敛式：布局稳定即停，交互按需唤醒）──
      let raf = null
      let running = false
      function kick() {
        if (running) return
        running = true
        raf = requestAnimationFrame(loop)
      }
      function loop() {
        const active = step()
        draw()
        if (active || dragIdx >= 0 || panning) {
          raf = requestAnimationFrame(loop)
        } else {
          running = false
        }
      }
      function redraw() {
        if (!running) draw()
      }

      // ── tooltip ──
      const tip = document.createElement('div')
      tip.className = 'lx-graph-tip'
      tip.style.display = 'none'
      wrap.appendChild(tip)

      function wrapRect() {
        return wrap.getBoundingClientRect()
      }

      function toLocal(e) {
        const rect = wrapRect()
        return { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom }
      }

      function findNode(local) {
        const threshold = 24 / zoom
        let best = -1
        let bestD = threshold
        for (const n of nodes) {
          const d = Math.hypot(n.x - local.x, n.y - local.y) - (9 / zoom)
          if (d < bestD) { bestD = d; best = n.idx }
        }
        return best
      }

      function neighborsOf(idx) {
        const set = new Set([idx])
        for (const e of edges) {
          if (e.a === idx) set.add(e.b)
          if (e.b === idx) set.add(e.a)
        }
        return set
      }

      function showTip(e, idx) {
        if (idx < 0) { tip.style.display = 'none'; return }
        const n = nodes[idx]
        const idea = byId.get(n.id)
        const meta = STATUS_META[n.status] || STATUS_META.seed
        tip.innerHTML = `
          <div class="lx-graph-tip-title">${escapeHtml(n.title)}</div>
          <div class="lx-graph-tip-row"><span class="lx-dot" style="background:${meta.color}"></span>${meta.label}${n.overall > 0 ? ` · 评分 <b style="color:${meta.color}">${n.overall}</b>` : ''}</div>
          ${(idea.tags || []).length ? `<div class="lx-graph-tip-tags">${(idea.tags || []).slice(0, 4).map(t => `<span class="lx-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        `
        tip.style.display = 'block'
        const rect = wrapRect()
        const lx = e.clientX - rect.left
        const ly = e.clientY - rect.top
        tip.style.left = `${Math.min(lx + 14, rect.width - 220)}px`
        tip.style.top = `${Math.min(ly + 14, rect.height - 110)}px`
      }

      // ── 事件 ──
      function onMouseMove(e) {
        const local = toLocal(e)
        const idx = findNode(local)
        if (idx !== hoverIdx) { hoverIdx = idx; showTip(e, idx); redraw() }
        if (dragIdx >= 0) {
          moved = true
          const n = nodes[dragIdx]
          n.x = local.x; n.y = local.y; n.vx = 0; n.vy = 0
          kick()
        } else if (panning) {
          pan.x = panStart.px + (e.clientX - panStart.x)
          pan.y = panStart.py + (e.clientY - panStart.y)
          kick()
        }
        canvas.style.cursor = dragIdx >= 0 ? 'grabbing' : (idx >= 0 ? 'pointer' : (panning ? 'grabbing' : 'default'))
      }

      function onMouseDown(e) {
        const local = toLocal(e)
        const idx = findNode(local)
        moved = false
        if (idx >= 0) {
          dragIdx = idx
          kick()
        } else {
          panning = true
          panStart = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
          kick()
        }
      }

      function onMouseUp() {
        dragIdx = -1
        panning = false
      }

      function onMouseLeave() {
        hoverIdx = -1
        dragIdx = -1
        panning = false
        tip.style.display = 'none'
        redraw()
      }

      function onClick(e) {
        if (moved) return
        const local = toLocal(e)
        const idx = findNode(local)
        if (idx >= 0) {
          selectedId = nodes[idx].id
          onSelect(selectedId)
        }
      }

      function onWheel(e) {
        e.preventDefault()
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
        const newZoom = Math.max(0.35, Math.min(3.2, zoom * factor))
        const rect = wrapRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        pan.x = mx - (mx - pan.x) * (newZoom / zoom)
        pan.y = my - (my - pan.y) * (newZoom / zoom)
        zoom = newZoom
        redraw()
      }

      canvas.addEventListener('mousemove', onMouseMove)
      canvas.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      canvas.addEventListener('mouseleave', onMouseLeave)
      canvas.addEventListener('click', onClick)
      canvas.addEventListener('wheel', onWheel, { passive: false })

      // ── 渲染 ──
      function draw() {
        width = wrap.clientWidth || width
        height = wrap.clientHeight || height
        const pw = Math.round(width * dpr)
        const ph = Math.round(height * dpr)
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw
          canvas.height = ph
          canvas.style.width = `${width}px`
          canvas.style.height = `${height}px`
        }
        const ctx = canvas.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
        ctx.translate(pan.x, pan.y)
        ctx.scale(zoom, zoom)

        let highlight = null
        if (hoverIdx >= 0) highlight = neighborsOf(hoverIdx)
        else if (selectedId !== null && nodeIndex.has(selectedId)) highlight = neighborsOf(nodeIndex.get(selectedId))

        // 边
        const edgeAlpha = { high: 0.55, medium: 0.38, low: 0.26 }
        for (const e of edges) {
          const a = nodes[e.a]
          const b = nodes[e.b]
          const active = highlight === null || highlight.has(e.a) || highlight.has(e.b)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.strokeStyle = hexToRgba(e.hex, active ? edgeAlpha[e.strength] : 0.05)
          ctx.lineWidth = (e.strength === 'high' ? 2.2 : e.strength === 'medium' ? 1.5 : 1) / zoom
          ctx.stroke()
        }

        // 节点
        for (const n of nodes) {
          const r = (9 + Math.min(13, (n.overall / 100) * 13)) / zoom
          const dimmed = highlight !== null && !highlight.has(n.idx)
          const isHover = n.idx === hoverIdx
          ctx.beginPath()
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
          ctx.fillStyle = n.status === 'merged' ? 'rgba(122,122,138,0.22)' : hexToRgba(n.hex, dimmed ? 0.07 : (isHover ? 0.34 : 0.2))
          ctx.fill()
          ctx.lineWidth = (isHover ? 2.4 : 1.5) / zoom
          ctx.strokeStyle = dimmed ? 'rgba(130,130,150,0.4)' : n.hex
          ctx.stroke()
          if (n.id === selectedId) {
            ctx.beginPath()
            ctx.arc(n.x, n.y, r + 4.5 / zoom, 0, Math.PI * 2)
            ctx.strokeStyle = n.hex
            ctx.lineWidth = 1.5 / zoom
            ctx.setLineDash([4 / zoom, 3 / zoom])
            ctx.stroke()
            ctx.setLineDash([])
          }
          if (n.overall > 0) {
            ctx.fillStyle = dimmed ? dimColor : labelColor
            ctx.font = `600 ${Math.round(10 / zoom)}px sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(String(n.overall), n.x, n.y)
          }
          ctx.fillStyle = dimmed ? dimColor : labelColor
          ctx.font = `${Math.round(11 / zoom)}px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          const label = n.title.length > 14 ? n.title.slice(0, 14) + '…' : n.title
          ctx.fillText(label, n.x, n.y + r + 4 / zoom)
        }
      }

      // ── 力导向步进 ──
      function step() {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]
            const b = nodes[j]
            const dx = b.x - a.x
            const dy = b.y - a.y
            let d = Math.hypot(dx, dy)
            if (d < 0.01) d = 0.01
            const f = (k * k) / d * 0.035
            const fx = (dx / d) * f
            const fy = (dy / d) * f
            if (i !== dragIdx) { a.vx -= fx; a.vy -= fy }
            if (j !== dragIdx) { b.vx += fx; b.vy += fy }
          }
        }
        for (const e of edges) {
          const a = nodes[e.a]
          const b = nodes[e.b]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d = Math.hypot(dx, dy) || 0.01
          const f = (d - k) * 0.012
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          a.vx += fx; a.vy += fy
          b.vx -= fx; b.vy -= fy
        }
        let active = false
        for (const n of nodes) {
          if (n.idx === dragIdx) { n.vx = 0; n.vy = 0; continue }
          n.vx += (width / 2 - n.x) * 0.0015
          n.vy += (height / 2 - n.y) * 0.0015
          n.vx *= 0.85
          n.vy *= 0.85
          n.x += n.vx
          n.y += n.vy
          if (Math.hypot(n.vx, n.vy) > 0.06) active = true
        }
        return active
      }

      // ── 启动初始布局动画（布局收敛后自动停止，交互时再唤醒）──
      kick()

      return () => {
        cancelAnimationFrame(raf)
        canvas.removeEventListener('mousemove', onMouseMove)
        canvas.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
        canvas.removeEventListener('mouseleave', onMouseLeave)
        canvas.removeEventListener('click', onClick)
        canvas.removeEventListener('wheel', onWheel)
        tip.remove()
      }
    }

    // ── 事件绑定 ────────────────────────────────────────────────────────────
    function bindPanelEvents(container) {
      container.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action], [data-view]')
        if (target === null) return
        // 弹层（data-stop）内部点击：只响应弹层内的 action，忽略冒泡到的外层 action。
        // 否则点击详情里的 select / 输入框会命中 overlay 的 close-detail，把详情关掉并
        // 销毁正在交互的 select，导致浏览器崩溃（闪退）。
        const stopBox = event.target.closest('[data-stop="true"]')
        if (stopBox !== null && !stopBox.contains(target)) return
        const action = target.dataset.action
        const view = target.dataset.view
        if (view) {
          setUI({ view, selectedId: null })
          return
        }
        switch (action) {
          case 'filter-status': setUI({ statusFilter: target.dataset.status }); break
          case 'filter-tag': setUI({ tagFilter: target.dataset.tag }); break
          case 'filter-domain': setUI({ domainFilter: target.dataset.domain }); break
          case 'open-idea': setUI({ selectedId: target.dataset.id }); break
          case 'close-detail': setUI({ selectedId: null }); break
          case 'add-note': handleAddNote(target.dataset.id, container); break
          case 'promote-project': handlePromote(target.dataset.id); break
          case 'delete-idea': handleDeleteIdea(target.dataset.id); break
          case 'delete-project': handleDeleteProject(target.dataset.project, target); break
          case 'delete-task': handleDeleteTask(target.dataset.project, target.dataset.task, target); break
          case 'merge-prompt': handleMergePrompt(target.dataset.id, container); break
          default: break
        }
      })

      // 点击 overlay 空白处关闭（data-action="close-detail" 在 overlay 上，但点击 modal 内部应阻止）。
      container.addEventListener('click', (event) => {
        const overlay = event.target.closest('.lx-overlay')
        if (overlay && event.target === overlay) {
          setUI({ selectedId: null })
        }
      })

      container.addEventListener('change', (event) => {
        const target = event.target
        if (target.matches('[data-action="task-status"]')) {
          handleTaskStatus(target.dataset.project, target.dataset.task, target.value)
        } else if (target.matches('[data-role="status-select"]')) {
          handleStatusChange(target.dataset.id, target.value)
        }
      })

      container.addEventListener('input', (event) => {
        if (event.target.matches('[data-role="search"]')) {
          ui.search = event.target.value
          emit()
        }
      })

      container.addEventListener('keydown', (event) => {
        if (event.target.matches('[data-role="note-input"]') && event.key === 'Enter') {
          event.preventDefault()
          const ideaId = event.target.closest('.lx-modal')?.querySelector('[data-action="add-note"]')?.dataset.id
          if (ideaId) handleAddNote(ideaId, container)
        } else if (event.target.matches('[data-role="task-input"]') && event.key === 'Enter') {
          event.preventDefault()
          handleAddTask(event.target.dataset.project, event.target.dataset.status, event.target.value)
          event.target.value = ''
        }
      })
    }

    // ── 具体操作 ────────────────────────────────────────────────────────────
    function handleAddNote(ideaId, container) {
      const input = container.querySelector('[data-role="note-input"]')
      const text = input ? input.value.trim() : ''
      if (text === '') return
      if (input) input.value = ''
      doAction({ kind: 'add-note', ideaId, text })
    }

    function handleStatusChange(ideaId, status) {
      doAction({ kind: 'update-idea', ideaId, patch: { status } })
    }

    function handleDeleteIdea(ideaId) {
      const idea = ui.data.ideas.find(i => i.id === ideaId)
      const name = idea ? (idea.title || idea.raw.slice(0, 20)) : ideaId
      if (!window.confirm(`确定删除想法「${name}」？此操作不可撤销。`)) return
      setUI({ selectedId: null })
      doAction({ kind: 'delete-idea', ideaId })
    }

    function handlePromote(ideaId) {
      const idea = ui.data.ideas.find(i => i.id === ideaId)
      if (!idea) return
      const name = window.prompt('项目名称：', idea.title || idea.raw.slice(0, 30) || '新项目')
      if (name === null || name.trim() === '') return
      doAction({ kind: 'create-project', id: uuid(), input: { ideaId, name: name.trim(), goal: idea.analysis || '' } })
    }

    function handleDeleteProject(projectId, button) {
      if (button !== undefined && button.dataset.confirming !== 'true') {
        // 第一阶段：进入确认态（3 秒内再点才执行，超时自动恢复）
        button.dataset.confirming = 'true'
        button.classList.add('confirming')
        button.textContent = '确认删除？'
        button.title = '再点一次确认删除'
        setTimeout(() => {
          if (button.isConnected && button.dataset.confirming === 'true') {
            delete button.dataset.confirming
            button.classList.remove('confirming')
            button.textContent = ''
            button.title = '删除项目'
            button.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4M4 4l.6 8.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8L12 4"/></svg>'
          }
        }, 3000)
        return
      }
      // 第二阶段：执行删除
      doAction({ kind: 'delete-project', projectId })
    }

    function handleAddTask(projectId, status, title) {
      const t = title.trim()
      if (t === '') return
      doAction({ kind: 'add-task', projectId, id: uuid(), input: { title: t, status } })
    }

    function handleTaskStatus(projectId, taskId, status) {
      doAction({ kind: 'update-task', projectId, taskId, patch: { status } })
    }

    function handleDeleteTask(projectId, taskId, button) {
      if (button !== undefined && button.dataset.confirming !== 'true') {
        button.dataset.confirming = 'true'
        button.classList.add('confirming')
        button.textContent = '确认？'
        button.title = '再点一次确认删除'
        setTimeout(() => {
          if (button.isConnected && button.dataset.confirming === 'true') {
            delete button.dataset.confirming
            button.classList.remove('confirming')
            button.textContent = '×'
            button.title = '删除任务'
          }
        }, 3000)
        return
      }
      doAction({ kind: 'delete-task', projectId, taskId })
    }

    function handleMergePrompt(ideaId) {
      const candidates = ui.data.ideas.filter(i => i.id !== ideaId && i.status !== 'merged')
      if (candidates.length === 0) {
        window.alert('没有可合并的想法。')
        return
      }
      const list = candidates.map((i, idx) => `${idx + 1}. ${i.title || i.raw.slice(0, 30)}`).join('\n')
      const answer = window.prompt(`选择要并入「${ui.data.ideas.find(i => i.id === ideaId)?.title || '该想法'}」的想法序号：\n\n${list}`, '1')
      if (answer === null) return
      const idx = Number(answer.trim()) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
        window.alert('序号无效。')
        return
      }
      doAction({ kind: 'merge-ideas', intoId: ideaId, fromId: candidates[idx].id, reason: '手动合并' })
    }

    // ── 焦点时刷新（与其他标签页/对话通道保持一致） ─────────────────────────
    function onVisibility() {
      if (document.visibilityState === 'visible' && ui.open) {
        reload()
      }
    }

    // ── 插件 apply ──────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => {
        const disposers = []
        try {
          disposers.push(mountSidebarEntry())
          disposers.push(mountPanel())
          document.addEventListener('visibilitychange', onVisibility)
          disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
          // 面板互斥：其他插件面板（ssh / taskboard 等）激活时，关闭灵犀，避免争抢中心列。
          const onOtherActivate = (event) => {
            if (event.detail !== PANEL_NAME && ui.open) closePanel()
          }
          document.addEventListener('dsh-panel-activate', onOtherActivate)
          disposers.push(() => document.removeEventListener('dsh-panel-activate', onOtherActivate))
        } catch (error) {
          console.error('[dsh-lingxi] mount failed:', error)
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, 'lingxi: mount')
    }

    return { apply, inject: [] }
  },
})
