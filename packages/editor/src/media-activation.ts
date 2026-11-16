import {useCallback,useEffect,useState,type RefObject} from "react";

// Share one browser observer per scroll region. Media activation is a view
// concern: it never changes the document, history or collaborative state.
type Queue={observer:IntersectionObserver;callbacks:Map<Element,()=>void>};
const queues=new Map<Element|null,Queue>();
function observe(element:Element,activate:()=>void){
  const root=element.closest(".document-region");
  let queue=queues.get(root);
  if(!queue){
    const callbacks=new Map<Element,()=>void>();
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){
        const callback=callbacks.get(entry.target);
        callbacks.delete(entry.target);observer.unobserve(entry.target);callback?.();
      }
      if(!callbacks.size){observer.disconnect();queues.delete(root);}
    },{root,rootMargin:"640px 0px",threshold:0});
    queue={observer,callbacks};queues.set(root,queue);
  }
  queue.callbacks.set(element,activate);queue.observer.observe(element);
  return ()=>{
    queue!.callbacks.delete(element);queue!.observer.unobserve(element);
    if(!queue!.callbacks.size){queue!.observer.disconnect();if(queues.get(root)===queue)queues.delete(root);}
  };
}

export function useMediaActivation(ref:RefObject<HTMLElement|null>,source:string){
  const [activatedSource,setActivatedSource]=useState<string|null>(null);
  const activated=activatedSource===source;
  const activate=useCallback(()=>setActivatedSource(source),[source]);
  useEffect(()=>{
    if(activated)return;
    const element=ref.current;if(!element)return;
    if(typeof IntersectionObserver==="undefined"){activate();return;}
    const stop=observe(element,activate);
    window.addEventListener("beforeprint",activate);
    return ()=>{stop();window.removeEventListener("beforeprint",activate);};
  },[activated,activate,ref]);
  return {activated,activate};
}
