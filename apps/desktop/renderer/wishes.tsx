import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { request, type User } from "./native";
import { Icon } from "./icons";
import { useDialog, DialogClose } from "./dialog";
import "./wishes.css";

const statuses: Record<string, string> = { submitted: translateUI("待评估"), planned: translateUI("计划中"), in_progress: translateUI("进行中"), completed: translateUI("已完成"), declined: translateUI("暂不采纳") };
const moderationLabels: Record<string,string> = {pending:translateUI("待审核"),published:translateUI("已显示"),rejected:translateUI("未通过")};
type Wish = { moderation_status: string; id: string; title: string; content: string; category: string; anonymous: boolean; author: string; submitter_name?: string; mine: boolean; status: string; reply: string; revision: number; created_at: string };
export function Wishes({ user, offline,headerControls,headerActions }: { user: User; offline: boolean;headerControls?:React.ReactNode;headerActions?:React.ReactNode }) {
  const [result, setResult] = useState<{items: Wish[]; total: number; page_size: number; review_mode: string}>({items: [],total: 0,page_size: 30,review_mode:"direct"});
  const [page, setPage] = useState(1), [status, setStatus] = useState(""), [mine, setMine] = useState(false), [moderation, setModeration] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false), [title, setTitle] = useState(""), [content, setContent] = useState(""), [category, setCategory] = useState("feature"), [anonymous, setAnonymous] = useState(false);
  const [editing, setEditing] = useState<Wish | null>(null), [reply, setReply] = useState(""), [nextStatus, setNextStatus] = useState("submitted"), [nextModeration,setNextModeration] = useState("published"), [deleting, setDeleting] = useState<Wish | null>(null);
  const createDialog = useDialog<HTMLFormElement>(() => setCreating(false), {open: creating, disabled: busy});
  const replyDialog = useDialog<HTMLFormElement>(() => setEditing(null), {open: !!editing, disabled: busy});
  const deleteDialog = useDialog<HTMLFormElement>(() => setDeleting(null), {open: !!deleting, disabled: busy});
  const sequence = useRef(0);
  async function refresh() {
    const current = ++sequence.current;
    if (offline) {setLoading(false); return;}
    setLoading(true);
    try {
      const data = await request(`wishes?${new URLSearchParams({page: String(page),mine: String(mine),status,moderation})}`);
      if (current === sequence.current) {setResult(data);setError("");}
    } catch(e) {if(current === sequence.current)setError(translateUI((e as Error).message));}
    finally {if(current === sequence.current)setLoading(false);}
  }
  useEffect(() => {void refresh(); return () => {sequence.current++;};}, [page,status,mine,moderation,offline]);
  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try {await action(); await refresh();} catch(e) {setError(translateUI((e as Error).message));} finally {setBusy(false);}
  }
  function openNew() {setTitle("");setContent("");setCategory("feature");setAnonymous(false);setCreating(true);setError("");}
  return <div className="academic-browser wishes-page">
    <header className="academic-page-header"><div className="compact-page-heading">{headerControls}<h1>{translateUI("许愿池")}</h1></div><div className="workspace-header-actions"><div className="academic-page-actions"><button disabled={loading || offline || busy} onClick={() => void refresh()}><Icon name="sync"/>{translateUI("刷新")}</button><button className="primary" disabled={offline || busy} onClick={openNew}><Icon name="plus"/>{translateUI("提个建议")}</button></div>{headerActions}</div></header>
    <div className="academic-list-controls wishes-filters"><nav className="home-tabs" aria-label={translateUI("建议范围")}>{[[false,translateUI("全部建议")],[true,translateUI("我的建议")]].map(([value,label]) => <button key={String(value)} className={mine === value ? "active" : ""} aria-pressed={mine === value} onClick={() => {setMine(value as boolean);setPage(1);}}>{label}</button>)}</nav><div className="wishes-filter-options"><label>{translateUI("处理状态")}<select value={status} onChange={e => {setStatus(e.target.value);setPage(1);}}><option value="">{translateUI("全部状态")}</option>{Object.entries(statuses).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>{user.is_admin && <label>{translateUI("展示状态")}<select aria-label={translateUI("展示筛选")} value={moderation} onChange={e=>{setModeration(e.target.value);setPage(1);}}><option value="">{translateUI("全部展示状态")}</option>{Object.entries(moderationLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}</div></div>
    {offline && <p role="status">{translateUI("连接平台后可查看和提交建议。")}</p>}
    {error && !creating && !editing && !deleting && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="wishes-notice">{notice}</p>}
    {loading ? <p role="status">{translateUI("正在加载建议…")}</p> : !offline && <>
      <div className="wishes-list" aria-label={translateUI("建议列表")}>{result.items.map(wish => <article key={wish.id} className="wish-item" data-wish-id={wish.id}>
        <div className="wish-heading"><h2>{wish.title}</h2><span className="wish-status" data-status={wish.status}>{statuses[wish.status]}</span>{wish.moderation_status !== "published" && <span className="wish-status wish-moderation">{moderationLabels[wish.moderation_status]}</span>}</div>
        <div className="wish-meta"><span>{wish.category === "feature" ? translateUI("功能建议") : translateUI("体验优化")}</span><span>{wish.author}{wish.mine ? translateUI("（我）") : ""}</span><time dateTime={wish.created_at}>{new Date(wish.created_at).toLocaleString(uiLocale())}</time></div>
        {wish.submitter_name && <small className="wish-trace">{translateUI("提交者：")}{wish.submitter_name}{translateUI("（仅平台管理员可见）")}</small>}
        <p className="wish-content">{wish.content}</p>
        {wish.reply && <div className="wish-reply"><strong>{translateUI("管理员回复")}</strong><p>{wish.reply}</p></div>}
        {(user.is_admin || wish.mine) && <div className="wish-actions">{user.is_admin && <button disabled={offline || busy} onClick={() => {setEditing(wish);setReply(wish.reply);setNextStatus(wish.status);setNextModeration(wish.moderation_status);setError("");}}>{translateUI("回复与状态")}</button>}<button className="danger-button" disabled={offline || busy} onClick={() => {setDeleting(wish);setError("");}}>{wish.mine ? translateUI("撤回建议") : translateUI("删除建议")}</button></div>}
      </article>)}</div>
      {!result.items.length && <p className="wishes-empty">{mine ? translateUI("还没有符合条件的我的建议") : translateUI("还没有符合条件的建议")}</p>}
      <footer className="wishes-pagination"><span>{translateUI("共 ")}{result.total}{translateUI(" 条")}</span><button disabled={page === 1 || loading || busy} onClick={() => setPage(value => value-1)}>{translateUI("上一页")}</button><span>{translateUI("第 ")}{page}{translateUI(" 页")}</span><button disabled={page * result.page_size >= result.total || loading || busy} onClick={() => setPage(value => value+1)}>{translateUI("下一页")}</button></footer>
    </>}
    {creating && <div className="modal academic-modal"><form ref={createDialog} className="academic-dialog wish-dialog" role="dialog" aria-modal="true" aria-label={translateUI("提个建议")} onSubmit={e => {e.preventDefault();void mutate(async () => {const created=await request("wishes","POST",{title,content,category,anonymous});setCreating(false);setNotice(created.moderation_status === "pending" ? translateUI("建议已提交，审核通过后其他用户可见") : translateUI("建议已提交"));setPage(1);});}}>
      <header><h2>{translateUI("提个建议")}</h2><DialogClose disabled={busy} onClick={() => setCreating(false)}/></header><label>{translateUI("标题")}<input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)}/></label><label>{translateUI("类型")}<select value={category} onChange={e => setCategory(e.target.value)}><option value="feature">{translateUI("功能建议")}</option><option value="improvement">{translateUI("体验优化")}</option></select></label><label>{translateUI("建议内容")}<textarea required maxLength={5000} rows={7} value={content} onChange={e => setContent(e.target.value)} placeholder={translateUI("你希望解决什么问题？期待怎样的使用方式？")}/></label>
      <label className="wish-anonymous"><input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)}/>{translateUI("匿名展示")}</label><small>{translateUI("建议仅登录用户可见。")}{result.review_mode === "approval" ? translateUI("审核通过后向其他用户展示。") : translateUI("提交后直接显示。")}{translateUI("匿名时其他用户看不到你的昵称和账号；平台管理员仍可追溯提交者。")}</small>{error && <p role="alert" className="error">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setCreating(false)}>{translateUI("取消")}</button><button className="primary" disabled={busy || offline || !title.trim() || !content.trim()}>{translateUI("提交建议")}</button></footer>
    </form></div>}
    {editing && <div className="modal academic-modal"><form ref={replyDialog} className="academic-dialog wish-dialog" role="dialog" aria-modal="true" aria-label={translateUI("处理建议")} onSubmit={e => {e.preventDefault();void mutate(async () => {await request("wishes/"+editing.id,"PATCH",{revision:editing.revision,status:nextStatus,reply,moderation_status:nextModeration});setEditing(null);setNotice(translateUI("处理结果已保存"));});}}><header><h2>{translateUI("处理建议")}</h2><DialogClose disabled={busy} onClick={() => setEditing(null)}/></header><p>{editing.title}</p><label>{translateUI("展示状态")}<select aria-label={translateUI("展示状态")} value={nextModeration} onChange={e=>setNextModeration(e.target.value)}>{Object.entries(moderationLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>{translateUI("处理状态")}<select value={nextStatus} onChange={e => setNextStatus(e.target.value)}>{Object.entries(statuses).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{translateUI("管理员回复")}<textarea rows={5} maxLength={3000} value={reply} onChange={e => setReply(e.target.value)}/></label>{error && <p role="alert" className="error">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setEditing(null)}>{translateUI("取消")}</button><button className="primary" disabled={busy || offline}>{translateUI("保存")}</button></footer></form></div>}
    {deleting && <div className="modal academic-modal"><form ref={deleteDialog} className="academic-dialog wish-dialog" role="dialog" aria-modal="true" aria-label={translateUI("删除建议")} onSubmit={e => {e.preventDefault();void mutate(async () => {await request("wishes/"+deleting.id,"DELETE");setDeleting(null);setNotice(translateUI("建议已删除"));if(page>1&&result.items.length===1)setPage(value => value-1);});}}><header><h2>{deleting.mine ? translateUI("撤回建议") : translateUI("删除建议")}</h2><DialogClose disabled={busy} onClick={() => setDeleting(null)}/></header><p>{translateUI("确定删除“")}{deleting.title}{translateUI("”？删除后无法恢复。")}</p>{error && <p role="alert" className="error">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setDeleting(null)}>{translateUI("取消")}</button><button className="danger-button" disabled={busy || offline}>{translateUI("确认删除")}</button></footer></form></div>}
  </div>;
}
