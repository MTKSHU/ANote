import { t as translateUI } from "@anote/i18n";
import React,{useEffect,useRef,useState} from 'react';

const unavailable=translateUI("音频暂时无法播放，请确认附件已下载或网络连接正常，也可下载后用本机播放器打开。");
function time(seconds:number){
  const value=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0)),minutes=Math.floor(value/60),rest=String(value%60).padStart(2,'0');
  return minutes>=60?`${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,'0')}:${rest}`:`${minutes}:${rest}`;
}

/** Keep HTMLMediaElement decoding and caching; expose ordinary DOM controls so
 * double-click reaches the application instead of Chromium's closed controls. */
export function AudioPlayer({src,title,onExpand}:{src:string;title?:string;onExpand:()=>void}){
  const audio=useRef<HTMLAudioElement>(null),progress=useRef<HTMLInputElement>(null),clock=useRef<HTMLOutputElement>(null);
  const [playing,setPlaying]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false);
  const silent=muted||volume===0;
  function syncTime(){
    const player=audio.current;if(!player)return;
    const duration=Number.isFinite(player.duration)&&player.duration>0?player.duration:0,current=Number.isFinite(player.currentTime)?player.currentTime:0;
    if(progress.current){progress.current.max=String(duration||1);progress.current.value=String(current);progress.current.disabled=!duration;progress.current.setAttribute('aria-valuetext',`${time(current)} / ${time(duration)}`);}
    if(clock.current)clock.current.textContent=`${time(current)} / ${time(duration)}`;
  }
  useEffect(()=>{
    const player=audio.current;if(!player)return;
    player.volume=volume;player.muted=muted;syncTime();
    return ()=>player.pause();
  },[src,attempt]);
  async function toggle(){
    const player=audio.current;if(!player)return;setError('');
    if(!player.paused){player.pause();return;}
    setBusy(true);
    try{await player.play();}catch(failure){if((failure as DOMException)?.name!=='AbortError')setError(unavailable);}finally{setBusy(false);}
  }
  function expand(){audio.current?.pause();onExpand();}
  function mute(){
    const player=audio.current;if(!player)return;
    if(player.volume===0){player.volume=1;player.muted=false;setVolume(1);setMuted(false);}
    else{player.muted=!player.muted;setMuted(player.muted);}
  }
  return <>
    <audio key={attempt} ref={audio} className="audio-element" hidden aria-hidden="true" src={src} preload="none"
      onLoadedMetadata={syncTime} onDurationChange={syncTime} onTimeUpdate={syncTime} onSeeking={syncTime}
      onPlay={()=>{setPlaying(true);setBusy(false);}} onPause={()=>setPlaying(false)} onEnded={()=>{setPlaying(false);syncTime();}}
      onVolumeChange={event=>{setVolume(event.currentTarget.volume);setMuted(event.currentTarget.muted);}}
      onError={()=>{setError(unavailable);setPlaying(false);setBusy(false);}}/>
    <div className="audio-controls" role="group" aria-label={translateUI("音频播放控件")} aria-description={translateUI("{0}；双击或按 Alt+Enter 展开播放", [title||translateUI("音频")])} aria-keyshortcuts="Alt+Enter" title={title||translateUI("音频")} tabIndex={0}
      onDoubleClick={event=>{event.preventDefault();event.stopPropagation();expand();}}
      onKeyDown={event=>{if(event.altKey&&event.key==='Enter'){event.preventDefault();event.stopPropagation();expand();}}}>
      <button type="button" className="audio-play-toggle" aria-label={playing?translateUI("暂停音频"):translateUI("播放音频")} aria-busy={busy} onClick={()=>void toggle()}>
        <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={playing?'M5 3h4v14H5zM12 3h4v14h-4z':'M5 3v14l12-7z'}/></svg>
      </button>
      <input ref={progress} className="audio-progress" type="range" min="0" max="1" step="0.1" defaultValue="0" disabled aria-label={translateUI("音频播放进度")} aria-valuetext="0:00 / 0:00" onChange={event=>{if(audio.current){audio.current.currentTime=Number(event.currentTarget.value);syncTime();}}}/>
      <output ref={clock} className="audio-time" aria-label={translateUI("播放时间")} aria-live="off">0:00 / 0:00</output>
      <button type="button" className="audio-mute-toggle" aria-label={silent?translateUI("取消静音"):translateUI("静音")} onClick={mute}>
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7h3l4-3v12l-4-3H3z"/>{silent?<path d="m13 7 5 6m0-6-5 6"/>:<path d="M13 7a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/>}</svg>
      </button>
      <input className="audio-volume" type="range" min="0" max="1" step="0.05" value={volume} aria-label={translateUI("音量")} onChange={event=>{const value=Number(event.currentTarget.value);setVolume(value);setMuted(false);if(audio.current){audio.current.volume=value;audio.current.muted=false;}}}/>
    </div>
    {error&&<p role="status">{error}<button type="button" onClick={()=>{setError('');setPlaying(false);setBusy(false);setAttempt(value=>value+1);}}>{translateUI("重新加载播放器")}</button></p>}
  </>;
}
