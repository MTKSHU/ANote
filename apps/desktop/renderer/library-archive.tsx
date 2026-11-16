import { t as translateUI } from "@anote/i18n";
import React,{useState} from 'react';
import {request} from './native';
import {useDialog,DialogClose} from './dialog';
import {flushBeforeReload} from './reload-guards';
import './library-archive.css';

export type ArchiveLibrary={id:string;name:string;archived?:boolean;archive_revision?:string|number};
export function LibraryArchiveDialog({library,onClose,onChanged,onError,local=false}:{library:ArchiveLibrary;onClose:()=>void;onChanged:()=>void|Promise<void>;onError:(error:unknown)=>void;local?:boolean}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const close=()=>{if(!busy)onClose();},ref=useDialog<HTMLFormElement>(close);
  return <div className="modal academic-modal"><form ref={ref} className="academic-dialog" role="dialog" aria-modal="true" aria-label={library.archived?translateUI("恢复知识库"):translateUI("归档知识库")} onSubmit={async event=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await flushBeforeReload();await request(`spaces/${library.id}/archive`,'PATCH',{archived:!library.archived,revision:library.archive_revision||0});await onChanged();onClose();}
    catch(error){setError(translateUI((error as Error).message));onError(error);}finally{setBusy(false);}
  }}><header><h2>{library.archived?translateUI("恢复知识库"):translateUI("归档知识库")}</h2><DialogClose onClick={close} disabled={busy}/></header>
    <p>{library.archived?translateUI("恢复“{0}”后，成员可按原有权限继续编辑。", [library.name]):translateUI("归档“{0}”后，整个知识库将变为只读，并从侧栏和最近笔记中隐藏。", [library.name])}</p>
    <p className="muted">{library.archived?translateUI("笔记原有的单篇归档状态保持不变。"):translateUI("正文、附件、评论、历史版本和原有阅读授权均保留，可在“已归档”筛选中查看、搜索和导出，之后也可恢复。离线未同步的修改会保留，归档期间停止提交。")}</p>
    {local&&!library.archived&&<p className="muted">{translateUI("本地目录首次使用归档后需使用新版客户端打开，旧客户端将拒绝载入，防止忽略归档状态。")}</p>}
    {error&&<p role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>{translateUI("取消")}</button><button className="primary" disabled={busy}>{busy?translateUI("正在处理…"):library.archived?translateUI("确认恢复"):translateUI("确认归档")}</button></footer>
  </form></div>;
}
