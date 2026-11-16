import {useEffect,useState} from "react";

const compactQuery="(max-width: 760px), (max-width: 1100px) and (pointer: coarse)";
export function useMobileWorkspace() {
  const [mobile,setMobile]=useState(()=>typeof matchMedia!=="undefined"&&matchMedia(compactQuery).matches);
  const [height,setHeight]=useState(()=>typeof window==="undefined"?0:Math.round(window.visualViewport?.height||window.innerHeight));
  useEffect(()=>{
    const media=matchMedia(compactQuery),update=()=>setMobile(media.matches);
    update();media.addEventListener("change",update);return()=>media.removeEventListener("change",update);
  },[]);
  useEffect(()=>{
    if(!mobile)return;
    const update=()=>setHeight(Math.round(window.visualViewport?.height||window.innerHeight));
    update();window.visualViewport?.addEventListener("resize",update);window.addEventListener("resize",update);
    return()=>{window.visualViewport?.removeEventListener("resize",update);window.removeEventListener("resize",update);};
  },[mobile]);
  return {mobile,height};
}
