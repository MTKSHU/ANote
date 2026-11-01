import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { request, type NativeState } from "./native";
export type Theme = "light" | "dark" | "auto";
const validTheme = (value: unknown): value is Theme => ["light","dark","auto"].includes(value as string);
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let systemListenerInstalled = false;
function cached(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null") as {
      theme: Theme;
      dirty: boolean;
    } | null;
    return value && validTheme(value.theme)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function applyTheme(theme: Theme, animate = true) {
  const resolved = theme === "auto" ? matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light" : theme;
  const root=document.documentElement;
  if(animate && root.dataset.theme && root.dataset.theme !== resolved){
    root.classList.add("theme-changing");clearTimeout(transitionTimer);transitionTimer=setTimeout(()=>root.classList.remove("theme-changing"),220);
  }
  root.dataset.theme = resolved;
  root.dataset.themeMode = theme;
  root.style.colorScheme = resolved;
  try { localStorage.setItem("academic-notes:appearance", theme); } catch {}
}
export function initializeTheme() {
  let theme: Theme = "auto";
  try { const saved=localStorage.getItem("academic-notes:appearance");if(validTheme(saved)) theme=saved; } catch {}
  applyTheme(theme,false);
  if(!systemListenerInstalled){
    matchMedia("(prefers-color-scheme:dark)").addEventListener("change",()=>{if(document.documentElement.dataset.themeMode === "auto")applyTheme("auto");});
    systemListenerInstalled=true;
  }
}
export function useTheme(state: NativeState, onError: (e: unknown) => void) {
  const key = `academic-notes:appearance:${state.serverURL}:${state.user!.id}`;
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = cached(key);
    return saved && (state.desktop || saved.dirty || state.offline)
      ? saved.theme
      : state.user?.theme || saved?.theme || "auto";
  });
  const [retry, setRetry] = useState(0),
    [saving, setSaving] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const choiceRevision = useRef(0);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    const focus = () => setRetry((n) => n + 1);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    // Desktop credentials retain the user returned by the original login.
    // Read current account preferences without overwriting an offline choice
    // or a newer selection made while this request was in flight.
    if (
      !state.desktop ||
      state.validationMode ||
      state.offline ||
      cached(key)?.dirty
    )
      return;
    let current = true;
    const revision = choiceRevision.current;
    request("me")
      .then((user) => {
        if (
          !current ||
          revision !== choiceRevision.current ||
          cached(key)?.dirty
        )
          return;
        if (validTheme(user.theme)) {
          setTheme(user.theme);
          localStorage.setItem(
            key,
            JSON.stringify({ theme: user.theme, dirty: false }),
          );
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [
    key,
    state.desktop,
    state.validationMode,
    state.offline,
    state.token,
    retry,
  ]);
  useEffect(() => {
    const saved = cached(key);
    if (state.offline || !saved?.dirty) return;
    let current = true;
    setSaving(true);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (current) await request("me/preferences", "PATCH", { theme });
      })
      .then(() => {
        if (current && cached(key)?.theme === theme)
          localStorage.setItem(key, JSON.stringify({ theme, dirty: false }));
      })
      .catch(() => {
        if (current)
          onError(new Error(translateUI("主题已保存在本机，联网后会再次同步账号偏好")));
      })
      .finally(() => {
        if (current) setSaving(false);
      });
    return () => {
      current = false;
    };
  }, [key, theme, state.offline, state.token, retry]);
  function choose(next: Theme) {
    if (next === theme) return;
    choiceRevision.current++;
    try {
      localStorage.setItem(key, JSON.stringify({ theme: next, dirty: true }));
    } catch {}
    setTheme(next);
  }
  return { theme, choose, saving };
}

const themeOptions = [{mode:"light",icon:"sun",label:"Light",description:translateUI("明亮")},{mode:"dark",icon:"moon",label:"Dark",description:translateUI("暗黑")},{mode:"auto",icon:"monitor",label:"Auto",description:translateUI("跟随系统")}] as const;
export function AppearanceButton({appearance}:{appearance:ReturnType<typeof useTheme>}) {
  const [open,setOpen]=useState(false),[anchor,setAnchor]=useState({left:0,bottom:0});
  const button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const option=themeOptions.find(o=>o.mode===appearance.theme)!;
  function close(){setOpen(false);button.current?.focus();}
  useEffect(()=>{
    if(!open)return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key === "Escape"){event.preventDefault();event.stopPropagation();close();}};
    const reposition=()=>setOpen(false);
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);window.addEventListener("resize",reposition);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);window.removeEventListener("resize",reposition);};
  },[open]);
  return <><button ref={button} className="sidebar-appearance-switch" aria-label={translateUI("外观模式")} aria-haspopup="menu" aria-expanded={open} aria-busy={appearance.saving} title={translateUI("外观：{0}（{1}）", [option.label, option.description])} onClick={()=>{const rect=button.current!.getBoundingClientRect();setAnchor({left:Math.max(8,Math.min(rect.left,window.innerWidth-220)),bottom:window.innerHeight-rect.top+10});setOpen(!open);}}>
    <span className="appearance-icon" key={appearance.theme}><Icon name={option.icon} size={17}/></span><span aria-hidden="true">{option.label}</span>
  </button>{open&&createPortal(<div ref={menu} className="appearance-menu" role="menu" aria-label={translateUI("外观模式")} style={anchor} onKeyDown={event=>{
    const items=[...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')],index=items.indexOf(document.activeElement as HTMLButtonElement);
    let next:number|undefined;
    if(event.key === "ArrowDown")next=(index+1)%items.length;
    if(event.key === "ArrowUp")next=(index+items.length-1)%items.length;
    if(event.key === "Home")next=0;if(event.key === "End")next=items.length-1;
    if(next!==undefined){event.preventDefault();items[next].focus();}
  }}>{themeOptions.map(item=><button key={item.mode} role="menuitemradio" aria-checked={appearance.theme===item.mode} onClick={()=>{appearance.choose(item.mode);close();}}><Icon name={item.icon} size={18}/><span><strong>{item.label}</strong><small>{item.description}</small></span><span className="appearance-check" aria-hidden="true">{appearance.theme===item.mode?"✓":""}</span></button>)}</div>,document.body)}</>;
}
