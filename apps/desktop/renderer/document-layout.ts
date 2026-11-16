import {useLayoutEffect,useState,type RefObject} from 'react';

/** Floating panels live outside the note's scroll and container-query subtree.
 * Their coordinates still follow the rendered sticky rows and visual viewport. */
export function useDocumentChrome(region:RefObject<HTMLElement|null>,layoutKey:unknown,floating=false){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    const root=region.current;if(!root)return;
    const header=root.querySelector<HTMLElement>('.document-header'),info=root.querySelector<HTMLElement>('.document-info'),workspace=root.closest('.academic-workspace');
    const layer=floating&&workspace?document.createElement('div'):null;
    if(layer){layer.className='document-floating-layer';workspace!.append(layer);setTarget(layer);}
    const measure=()=>{
      if(!header)return;
      const rect=header.getBoundingClientRect(),bottom=Math.max(rect.bottom,info?.getBoundingClientRect().bottom||0),viewport=window.visualViewport,top=Math.max((viewport?.offsetTop||0)+8,bottom+8),end=(viewport?.offsetTop||0)+(viewport?.height||window.innerHeight);
      root.style.setProperty('--document-header-height',rect.height+'px');
      for(const element of layer?[root,layer]:[root]){
        element.style.setProperty('--document-panel-top',top+'px');
        element.style.setProperty('--document-viewport-bottom',end+'px');
      }
      if(layer)layer.hidden=!root.getClientRects().length;
    };
    const observer=new ResizeObserver(measure);if(header)observer.observe(header);if(info)observer.observe(info);observer.observe(root);
    measure();root.addEventListener('scroll',measure,{passive:true});window.addEventListener('resize',measure);window.addEventListener('scroll',measure,{passive:true});window.visualViewport?.addEventListener('resize',measure);window.visualViewport?.addEventListener('scroll',measure);
    return()=>{observer.disconnect();root.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure);window.visualViewport?.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('scroll',measure);layer?.remove();};
  },[region,layoutKey,floating]);
  return target;
}
