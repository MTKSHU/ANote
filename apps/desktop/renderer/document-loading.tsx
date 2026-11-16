import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useState} from 'react';

/** Only a pending readable body gets a delayed indicator. Completion/errors
 * remove it synchronously, even before the timer cleanup effect runs. */
export function DocumentLoading({requestKey,pending,error='',message=translateUI("正在读取笔记"),hint,overlay=false}:{requestKey:string;pending:boolean;error?:string;message?:string;hint?:string;overlay?:boolean}){
  const [shownFor,setShownFor]=useState<string|null>(null);
  useEffect(()=>{
    setShownFor(null);
    if(!pending||error)return;
    const timer=setTimeout(()=>setShownFor(requestKey),500);
    return()=>clearTimeout(timer);
  },[requestKey,pending,error]);
  if(error)return <div className="doc-loading document-loading document-loading-error" role="alert">{error}</div>;
  if(!pending)return null;
  const shown=shownFor===requestKey;
  return <div className={'doc-loading document-loading'+(overlay?' document-loading-overlay':'')} data-testid="note-loading-placeholder">
    {shown&&<div className="document-loading-status" data-testid="note-loading-indicator" role="status" aria-live="polite" aria-label={message}>
      <span className="document-loading-label">{message}</span>
      <span className="document-loading-dots" aria-hidden="true"><span/><span/><span/></span>
      {hint&&<p className="document-loading-hint">{hint}</p>}
    </div>}
  </div>;
}
