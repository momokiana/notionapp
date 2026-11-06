import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Client } from './client.ts';
import { dispositionNames, dispositions, type Event, type History, type Notice, type SourceDelivery, type Disposition } from './contracts.ts';
import './style.css';
declare const __DEPLOYMENT__: { instance: string; target: string };
const client = new Client(location.origin, JSON.stringify(__DEPLOYMENT__));
const date = (v: string | null) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '未观察';
const stateName = (s: string) => ({ waiting_source: '等待来源处理', source_received: '来源已报告收件', effect_unknown: '来源效果未知', blocked: '当前资格被阻止', expired: '已过期', platform_accepted: '平台已接受', not_observed: '未观察', not_verified: '未独立核验', failed: '平台失败', withheld: '已抑制' }[s] ?? s);
function Source({ delivery }: { delivery: SourceDelivery | null }) {
  return <><dt>来源交付</dt><dd>{stateName(delivery?.state ?? 'not_observed')}{delivery?.command_id && <details><summary>原命令与回执</summary><pre>{JSON.stringify(delivery, null, 2)}</pre></details>}</dd></>;
}
function Notification({ notice, title }: { notice: Notice | null; title: string }) {
  return <><dt>{title}</dt><dd>{notice ? <>{`v${notice.version} · ${stateName(notice.platform_state)}`}<br />设备报告收到：{date(notice.device_received_at)}<br />设备报告调用通知：{date(notice.notification_posted_at)}</> : '未观察此层回执'}</dd></>;
}
function Timeline({ items }: { items: History[] }) {
  const names: Record<string, string> = { event_created: '来源创建事件', response_saved: '服务保存回应', progress: '来源追加进展', source_result_reported: '来源自报结果', user_disposition: '用户事项决定', source_received: '适配器报告来源收件', command_claimed: '来源命令已领取，效果未知', command_update_link: '原命令关联更新' };
  return <ol className="timeline">{items.map(h => <li key={h.seq}><div className="timeline-meta"><strong>{names[h.kind] ?? h.kind}</strong><time>{date(h.created_at)}</time></div>
    {typeof h.data.body === 'string' && <p className="prose">{h.data.body}</p>}
    {h.kind === 'response_saved' && <p className="prose">{String((h.data.action as { label?: string })?.label ?? '')}{h.data.text ? `：${String(h.data.text)}` : ''}</p>}
    {h.kind === 'user_disposition' && <p>{dispositionNames[h.data.disposition as Disposition] ?? String(h.data.disposition)}</p>}
    <details><summary>查看原事实 #{h.seq}</summary><pre>{JSON.stringify(h.data, null, 2)}</pre></details>
  </li>)}</ol>;
}
function App() {
  const v = useSyncExternalStore(client.subscribe, client.snapshot);
  const [settings, setSettings] = useState(true), [token, setToken] = useState(''), [consent, setConsent] = useState(false);
  const [query, setQuery] = useState(''), [source, setSource] = useState(''), [filter, setFilter] = useState('all');
  const [actionId, setActionId] = useState(''), [reply, setReply] = useState(''), [decision, setDecision] = useState<Disposition>('paused'), [confirmDecision, setConfirmDecision] = useState(false);
  useEffect(() => { void client.start(); const f = () => client.lifecycle(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  useEffect(() => { setActionId(''); setReply(''); setConfirmDecision(false); }, [v.detail?.id, v.detail?.event_version, settings]);
  const busy = !!v.busy, e = v.detail, a = e?.interaction?.actions.find(x => x.id === actionId);
  const canWrite = !busy && v.authenticated && v.storage === 'ready' && !v.pending && v.fresh;
  const events = v.events.filter(x => (!query || (x.title + '\n' + x.body).toLowerCase().includes(query.toLowerCase())) && (!source || x.source_id === source) && (filter === 'all' || (filter === 'unread' ? x.read_state.unread : filter === 'respond' ? x.can_respond : x.disposition === filter)));
  async function connect(event: React.FormEvent) { event.preventDefault(); const original = token; setToken(''); await client.connect(original); if (client.snapshot().authenticated) setSettings(false); }
  const chooseEvent = async (x: Event) => { await client.select(x.id); document.querySelector<HTMLElement>('#detail-heading')?.focus(); };
  return <div className="app">
    <a className="skip" href="#main">跳至主要内容</a>
    <header className="topbar"><div className="wordmark"><span className="mark" aria-hidden="true">↳</span><strong>通知与交互</strong><span className="platform">Web</span></div>
      <div className="top-actions"><span className="connection-state"><i className={v.authenticated ? 'dot connected' : 'dot'} />{v.authenticated ? '前台可读取' : '未确认连接'}</span><button className={settings ? 'selected' : ''} onClick={() => { client.lifecycle(false); client.lifecycle(true); setSettings(!settings); }}>连接与本机</button></div>
    </header>
    <div className="feedback" aria-live="polite" aria-atomic="true">
      {v.busy && <p className="working" role="status">{v.busy}…</p>}
      {v.error && <p className="error" role="alert">{v.error}</p>}
      {v.message && <p className="message">{v.message}</p>}
    </div>
    {v.pending && <aside className="pending" aria-label="未决提交"><div><strong>原提交结果待核实，所有新写入已暂停</strong><p>{v.pending.kind === 'response' ? '回应' : v.pending.kind === 'read' ? '已读' : '事项决定'} · {v.pending.event.title} · 原ID <code>{v.pending.id}</code></p><p>不会自动重发。{v.pending.namespace === v.connection?.namespace ? '请只读核对原请求。' : '请连接准确原凭据和服务实例，不能用另一身份接管。'}</p></div><button disabled={busy || !v.connection || v.pending.namespace !== v.connection.namespace} onClick={() => void client.recover()}>查询原请求</button></aside>}
    <main id="main">
      {settings ? <section className="settings" aria-labelledby="settings-heading"><div className="section-title"><div><h1 id="settings-heading">连接与本机</h1><p>凭据只留在此页面内存，刷新或关闭后需要重新输入。</p></div>{v.authenticated && <button onClick={() => setSettings(false)}>返回收件箱</button>}</div>
        <div className="settings-columns"><section><h2>事件服务</h2><dl className="facts"><dt>浏览器 API 根</dt><dd><code>{location.origin}/api</code></dd><dt>固定上游</dt><dd><code>{__DEPLOYMENT__.target}</code></dd><dt>部署实例</dt><dd>{__DEPLOYMENT__.instance}</dd></dl>
          <form onSubmit={event => void connect(event)}><label htmlFor="token">用户设备凭据</label><input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} aria-describedby="credential-help" />
            <p className="hint" id="credential-help">管理员供应的64位凭据。不放入URL、不记日志、不在浏览器持久保存；来源凭据不等于用户权限。</p><div className="button-row"><button className="primary" disabled={busy || token.length !== 64} type="submit">连接事件服务</button>{v.connection && <button type="button" disabled={busy} onClick={() => client.disconnect()}>移除内存凭据</button>}</div>
          </form>
          {v.connection && <section className="identity"><h3>当前身份边界</h3><p>凭据指纹 <code>{v.connection.fingerprint.slice(0, 16)}</code></p>{v.device ? <dl className="facts"><dt>设备 actor</dt><dd>{v.device.device_id}</dd><dt>所有者</dt><dd>{v.device.owner_id}</dd><dt>权限库</dt><dd>{v.device.store_id}</dd><dt>凭据版本</dt><dd>{v.device.credential_version}</dd></dl> : <p>手工凭据模式。服务未确认设备 actor，指纹不等于身份自证。</p>}</section>}
        </section><section><h2>本机提交账本</h2><p>只保存原请求ID、目标与业务文字，使用 IndexedDB，未加密。这不是 Android Keystore；同源脚本和浏览器扩展仍可能访问。</p>
          {v.storage === 'new' ? <><p className="warning">首次使用与“所有浏览器数据被清除”无法自动区分。若曾有未决提交，先在原服务人工对账，不要初始化来绕过未知。</p><label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我已确认此浏览器没有需要恢复的未决提交</label><button disabled={!consent || busy} onClick={() => void client.initialize()}>建立本机提交账本</button></> : <p className={v.storage === 'ready' ? 'status-line' : 'warning'}>{v.storage === 'ready' ? '提交账本可用，原意图先持久化再发送' : v.storage === 'checking' ? '正在检查本机账本' : '账本缺失、不一致或不可访问，保持只读，未自动重建'}</p>}
          {!navigator.locks && <p className="warning">此浏览器不支持 Web Locks，提交只读。</p>}
          <h3>恢复限制</h3><p>换 origin、浏览器、隐私窗口或清除全部数据会丢失本机记录，不能证明原提交没有发生。事项决定和已读丢回执时，现有服务不能精确查询原请求，本客户端会保留未决并阻止新写入。</p>
          <h3>当前不支持</h3><p>原生推送、系统通知、后台与锁屏、Keystore、配对管理。前台页面连接不是后台推送。持久离线缓存、回应草稿与模板将在后继切片接续。</p>
        </section></div>
      </section> : <div className={'workspace' + (e ? ' has-detail' : '')}>
        <section className="inbox" aria-labelledby="inbox-heading"><div className="section-title"><div><h1 id="inbox-heading">收件箱</h1><p>当前窗口 {v.events.length} 条 · 创建顺序</p></div><button disabled={busy || !v.connection} onClick={() => void client.refresh()}>刷新事件</button></div>
          <div className="filters"><label htmlFor="query" className="sr-only">搜索当前窗口</label><input id="query" placeholder="搜索当前窗口的标题与正文" value={query} onChange={event => setQuery(event.target.value)} />
            <div className="filter-pair"><label>状态<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="unread">未读</option><option value="respond">可回应</option>{dispositions.map(d => <option key={d} value={d}>{dispositionNames[d]}</option>)}</select></label><label>来源<select value={source} onChange={event => setSource(event.target.value)}><option value="">全部来源</option>{[...new Set(v.events.map(x => x.source_id))].map(s => <option key={s}>{s}</option>)}</select></label></div>
          </div>
          <p className="window-note">过滤仅当前窗口，最多100条。刷新会返回首段，不是更新订阅。</p>
          {busy && v.events.length === 0 ? <div className="skeleton" aria-label="正在读取事件"><div /><div /><div /></div> : <ul className="events">{events.map(x => <li key={x.id}><button className={'event-row' + (e?.id === x.id ? ' active' : '')} aria-current={e?.id === x.id ? 'true' : undefined} disabled={busy} onClick={() => void chooseEvent(x)}><div className="row-meta"><span>{x.source_id}</span><span>v{x.event_version}{x.read_state.unread ? ' · 未读' : ''}</span></div><strong>{x.title}</strong><p>{x.body}</p><span className="row-state">{x.can_respond ? '等待你的回应' : dispositionNames[x.disposition]}<time>{date(x.updated_at)}</time></span></button></li>)}</ul>}
          {!busy && events.length === 0 && <div className="empty"><h2>{v.events.length ? '当前筛选没有匹配' : '此窗口没有事件'}</h2><p>{v.events.length ? '清除筛选，或查看后续窗口。' : '有权限的来源发布事件后，刷新此页。这里不会自动创建测试事件。'}</p></div>}
          <div className="pagination">{v.next && <button disabled={busy} onClick={() => void client.nextEvents()}>{v.events.length >= 100 ? '查看后续窗口' : '加载后续事件'}</button>}{v.windowStart !== '0' && <button disabled={busy} onClick={() => void client.refresh()}>返回事件首段</button>}{!v.next && v.events.length > 0 && <span>已到当前服务列表末尾</span>}</div>
        </section>
        <section className="detail" aria-labelledby="detail-heading">{e ? <>
          <div className="detail-toolbar"><button className="back" disabled={busy} onClick={() => client.back()}>← 返回收件箱</button><span>{v.fresh ? '当前读取快照' : '旧快照，只读'} · {date(v.observedAt)}</span><button disabled={busy} onClick={() => void client.select(e.id)}>刷新当前事件</button></div>
          <div className="event-header"><div className="source-line">{e.source_id} <span>v{e.event_version} · {dispositionNames[e.disposition]}</span></div><h1 id="detail-heading" tabIndex={-1}>{e.title}</h1><p className="prose event-body">{e.body}</p><div className="event-meta"><span>更新于 {date(e.updated_at)}</span><span>操作期限 {date(e.expires_at)}</span></div></div>
          <section className="response-area" aria-labelledby="respond-heading"><div className="section-title"><h2 id="respond-heading">当前问题</h2><span>{e.interaction ? `交互 v${e.interaction.version}` : '没有交互'}</span></div>
            {e.can_respond && e.interaction ? <form onSubmit={event => { event.preventDefault(); if (a) void client.submit('response', a, reply); }}><fieldset disabled={!canWrite}><legend>选择操作，再明确提交</legend><div className="actions">{e.interaction.actions.map(x => <label key={x.id} className={'action' + (actionId === x.id ? ' chosen' : '')}><input type="radio" name="action" checked={actionId === x.id} onChange={() => setActionId(x.id)} />{x.label}{x.type === 'text' && <span>文字回应</span>}</label>)}</div>{a?.type === 'text' && <><label htmlFor="reply">回应原文</label><textarea id="reply" rows={4} value={reply} onChange={event => setReply(event.target.value)} aria-describedby="reply-count" /><p className="hint" id="reply-count">{[...reply].length} / 4000 字符，不会自动截断或移除首尾空白</p></>}
              {a && <p className="confirm-copy">将向当前事件 v{e.event_version} 保存“{a.label}”{a.type === 'button' ? '，按钮回应正文为空' : '及上方完整原文'}。服务保存不等于来源执行。</p>}<button className="primary" disabled={!a || (a.type === 'text' && (!reply.trim() || [...reply].length > 4000))} type="submit">提交回应</button></fieldset></form> : <p className="status-line">{e.reserved_response_id ? '此问题已有服务保存的回应，不能重复占用。' : '当前没有可回应的操作。可能已过期、暂停、关闭或来源不接受回应。'}</p>}
            {(!v.fresh || v.pending || v.storage !== 'ready') && <p className="hint">当前不能新提交：{v.pending ? '原请求待核实' : v.storage !== 'ready' ? '先到连接与本机建立或核对账本' : '请刷新当前事件重新确认'}。</p>}
          </section>
          <section className="receipts"><h2>分层回执</h2><dl className="facts"><dt>服务保存</dt><dd>{e.reserved_response_id ? <><span className="saved">已保存回应</span><br /><code>{e.reserved_response_id}</code></> : '当前问题未见已保存回应'}</dd><dt>阅读进度</dt><dd>已读到 v{e.read_state.version}，当前{e.read_state.unread ? '未读' : '已读'} <button className="small" disabled={!canWrite || !e.read_state.unread} onClick={() => void client.submit('read')}>明确标记此版已读</button></dd>
            {v.response && <><dt>当前回应资格</dt><dd>{stateName(v.response.eligibility_state)}<br /><code>{v.response.eligibility_reason}</code></dd><dt>原回应</dt><dd className="prose">{v.response.action.label}{v.response.text ? `：${v.response.text}` : ''}<br />所见事件 v{v.response.event_version_seen} · 原交互 v{v.response.interaction_version}</dd></>}
            <Source delivery={v.response?.source_delivery ?? e.source_delivery} /><dt>来源运行观察</dt><dd>{v.runtime}，不表示模型已授权或已经收件</dd><Notification title="当前版本通知" notice={e.notification_delivery} /><Notification title="较早版本通知" notice={e.previous_notification_delivery} /><dt>执行</dt><dd>未观察，不因保存或收件推断已执行</dd><dt>独立核验</dt><dd>未核验，来源结果只是自报</dd></dl>
          </section>
          <section className="disposition"><h2>事项决定</h2><p>这是你的跟进决定，不是来源执行或技术验收。暂停、完成或停止跟踪不保证撤回已在途效果。</p><div className="button-row"><label htmlFor="decision">改为</label><select id="decision" disabled={!canWrite} value={decision} onChange={event => { setDecision(event.target.value as Disposition); setConfirmDecision(false); }}>{dispositions.map(d => <option key={d} value={d}>{dispositionNames[d]}</option>)}</select><button disabled={!canWrite || decision === e.disposition} onClick={() => setConfirmDecision(true)}>核对此项决定</button></div>{confirmDecision && <div className="decision-confirm"><p>确认将事件 v{e.event_version} 从“{dispositionNames[e.disposition]}”改为“{dispositionNames[decision]}”？</p><div className="button-row"><button className="primary" disabled={!canWrite} onClick={() => void client.submit('disposition', decision)}>确认保存事项决定</button><button onClick={() => setConfirmDecision(false)}>取消决定</button></div></div>}</section>
          <section className="history"><div className="section-title"><h2>事件历史</h2><span>当前窗口 {v.history.length} 条</span></div><p className="hint">按服务提交顺序，最多200条。旧问题和旧操作仅供查看。</p><Timeline items={v.history} /><div className="pagination">{v.historyNext && <button disabled={busy} onClick={() => void client.nextHistory()}>{v.history.length >= 200 ? '查看后续历史窗口' : '加载后续历史'}</button>}{v.historyStart !== '0' && <button disabled={busy} onClick={() => void client.nextHistory(true)}>返回历史首段</button>}</div></section>
          <details className="identity-details"><summary>准确事件身份与绑定</summary><dl className="facts"><dt>事件ID</dt><dd><code>{e.id}</code></dd><dt>所有者</dt><dd>{e.owner_id}</dd><dt>来源代次</dt><dd>{e.source_epoch}</dd><dt>原会话引用</dt><dd><code>{e.session_ref}</code></dd><dt>目标修订</dt><dd>{e.target_revision}</dd></dl></details>
        </> : <div className="detail-empty"><span className="empty-symbol" aria-hidden="true">↳</span><h2>选择一件事</h2><p>查看当前问题、原回应与后续结果。打开详情不会自动标记已读。</p></div>}</section>
      </div>}
    </main><footer>仅前台 Web 客户端 · 没有原生系统通知 · 已读 ≠ 来源收件 ≠ 已执行 ≠ 独立核验</footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
