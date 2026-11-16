import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import "../panorama.css";

type View = { yaw: number; pitch: number; fov: number };
type Props = { src: string; kind: "image" | "video"; title?: string };
const initialView: View = { yaw: 0, pitch: 0, fov: 75 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function timestamp(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
function durationOf(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return Math.max(0, video.duration);
  return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
}

/** A local, single-eye equirectangular viewer. Camera changes never modify a note. */
export function PanoramaViewer({ src, kind, title }: Props) {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  const [view, setView] = useState<View>(initialView), viewRef = useRef<View>(initialView);
  const [ready, setReady] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [duration, setDuration] = useState(0), [volume, setVolume] = useState(1);
  const volumeRef = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>()), requestRender = useRef<() => void>(() => {});

  function changeView(next: View) {
    const normalized = {
      yaw: ((next.yaw + 180) % 360 + 360) % 360 - 180,
      pitch: clamp(next.pitch, -85, 85),
      fov: clamp(next.fov, 30, 100),
    };
    viewRef.current = normalized;
    setView(normalized);
    requestRender.current();
  }
  function zoom(factor: number) { changeView({ ...viewRef.current, fov: viewRef.current.fov * factor }); }
  async function play() {
    const element = video.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    try { await element.play(); }
    catch { setNotice(translateUI("视频暂时无法播放，请再次点击播放或打开原件。")); }
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else setNotice(translateUI("当前设备不支持全屏，可使用媒体预览窗口查看。"));
    } catch { setNotice(translateUI("无法进入全屏，请使用媒体预览窗口查看。")); }
  }

  useEffect(() => {
    const container = viewport.current!;
    let closed = false, frame = 0, failed = false, loaded = false;
    let renderer: THREE.WebGLRenderer | undefined, geometry: THREE.SphereGeometry | undefined;
    let material: THREE.MeshBasicMaterial | undefined, texture: THREE.Texture | undefined, image: HTMLImageElement | undefined;
    let observer: ResizeObserver | undefined, scene: THREE.Scene | undefined, camera: THREE.PerspectiveCamera | undefined;
    let sourceCleanup: (() => void) | undefined;
    const element = kind === "video" ? video.current : null;
    setReady(false); setError(""); setNotice(""); setPlaying(false); setTime(0); setDuration(0);
    pointers.current.clear(); viewRef.current = { ...initialView }; setView({ ...initialView });

    function fail(message: string) {
      if (closed || failed) return;
      failed = true; setError(message); setReady(false);
      cancelAnimationFrame(frame); frame = 0;
      element?.pause();
    }
    function render() {
      frame = 0;
      if (closed || failed || document.hidden || !renderer || !scene || !camera || !loaded) return;
      try {
        const value = viewRef.current, yaw = THREE.MathUtils.degToRad(value.yaw), pitch = THREE.MathUtils.degToRad(value.pitch);
        camera.fov = value.fov; camera.updateProjectionMatrix();
        camera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
        renderer.render(scene, camera); setReady(true);
        // Images render only on demand; videos render only while playing in a visible tab.
        if (element && !element.paused && !element.ended) schedule();
      } catch { fail(translateUI("当前设备无法渲染此全景素材，请打开原件查看。")); }
    }
    function schedule() {
      if (!closed && !failed && !document.hidden && !frame) frame = requestAnimationFrame(render);
    }
    requestRender.current = schedule;
    function visibility() {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else schedule();
    }
    function wheel(event: WheelEvent) {
      event.preventDefault(); event.stopPropagation();
      changeView({ ...viewRef.current, fov: viewRef.current.fov * Math.exp(clamp(event.deltaY, -200, 200) * .002) });
    }
    function dimensions(width: number, height: number) {
      if (width > 0 && height > 0 && Math.abs(width / height - 2) > .08)
        setNotice(translateUI("此素材不是常见的 2∶1 全景比例，等距柱状投影可能出现变形。"));
    }
    function contextLost(event: Event) {
      event.preventDefault();
      fail(translateUI("全景渲染已中断，请重新打开预览或打开原件。"));
    }
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x10141c);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.dataset.testid = "panorama-canvas";
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      container.appendChild(renderer.domElement);
      scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(75, 1, .1, 100);
      geometry = new THREE.SphereGeometry(10, 64, 40);
      geometry.scale(-1, 1, 1);
      // Put the middle of the source panorama directly ahead at the initial view.
      geometry.rotateY(-Math.PI / 2);
      material = new THREE.MeshBasicMaterial({ toneMapped: false });
      scene.add(new THREE.Mesh(geometry, material));
      const resize = () => {
        if (closed || !renderer || !camera) return;
        const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
        renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); schedule();
      };
      observer = new ResizeObserver(resize); observer.observe(container); resize();
      container.addEventListener("wheel", wheel, { passive: false });
      document.addEventListener("visibilitychange", visibility);
      if (element) {
        const metadata = () => {
          if (closed) return;
          dimensions(element.videoWidth, element.videoHeight);
          setDuration(durationOf(element));
          if (Math.max(element.videoWidth, element.videoHeight) > renderer!.capabilities.maxTextureSize)
            fail(translateUI("全景视频分辨率超过当前设备的渲染能力，请使用较低分辨率或打开原件。"));
        };
        const available = () => {
          if (closed || failed) return;
          metadata();
          if (failed) return;
          if (!texture) {
            texture = new THREE.VideoTexture(element);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
            material!.map = texture; material!.needsUpdate = true;
          }
          loaded = true; schedule();
        };
        const invalid = () => fail(translateUI("无法读取全景视频，或当前浏览器不支持其编码；请打开原件查看。"));
        const changed = () => { if (!closed) { setTime(element.currentTime); setDuration(durationOf(element)); schedule(); } };
        const playback = () => { if (!closed) { setPlaying(!element.paused && !element.ended); schedule(); } };
        element.addEventListener("loadedmetadata", metadata);
        element.addEventListener("loadeddata", available);
        element.addEventListener("error", invalid);
        element.addEventListener("timeupdate", changed);
        element.addEventListener("durationchange", changed);
        element.addEventListener("seeked", available);
        element.addEventListener("play", playback);
        element.addEventListener("pause", playback);
        element.addEventListener("ended", playback);
        sourceCleanup = () => {
          element.removeEventListener("loadedmetadata", metadata);
          element.removeEventListener("loadeddata", available);
          element.removeEventListener("error", invalid);
          element.removeEventListener("timeupdate", changed);
          element.removeEventListener("durationchange", changed);
          element.removeEventListener("seeked", available);
          element.removeEventListener("play", playback);
          element.removeEventListener("pause", playback);
          element.removeEventListener("ended", playback);
          element.pause(); element.removeAttribute("src"); element.load();
        };
        element.volume = volumeRef.current; element.muted = volumeRef.current === 0;
        element.src = src; element.load();
      } else {
        image = new Image();
        image.onload = () => {
          if (closed || failed) return;
          try {
            dimensions(image!.naturalWidth, image!.naturalHeight);
            const limit = renderer!.capabilities.maxTextureSize;
            let source: HTMLImageElement | HTMLCanvasElement = image!;
            if (Math.max(image!.naturalWidth, image!.naturalHeight) > limit) {
              const scale = limit / Math.max(image!.naturalWidth, image!.naturalHeight), reduced = document.createElement("canvas");
              reduced.width = Math.max(1, Math.round(image!.naturalWidth * scale)); reduced.height = Math.max(1, Math.round(image!.naturalHeight * scale));
              const context = reduced.getContext("2d");
              if (!context) throw new Error("Canvas unavailable");
              context.drawImage(image!, 0, 0, reduced.width, reduced.height); source = reduced;
              setNotice(translateUI("已按当前设备能力缩小预览，原始文件保持完整。"));
            }
            texture = new THREE.Texture(source); texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false; texture.needsUpdate = true;
            material!.map = texture; material!.needsUpdate = true; loaded = true; schedule();
          } catch { fail(translateUI("全景图片无法渲染，请打开原件查看。")); }
        };
        image.onerror = () => fail(translateUI("无法读取全景图片，文件可能已不可用或格式不受支持；请打开原件查看。"));
        image.src = src;
      }
    } catch { fail(translateUI("当前设备不支持 WebGL 全景预览，请打开原件查看。")); }
    return () => {
      closed = true; requestRender.current = () => {}; cancelAnimationFrame(frame);
      pointers.current.clear(); observer?.disconnect();
      container.removeEventListener("wheel", wheel); document.removeEventListener("visibilitychange", visibility);
      sourceCleanup?.();
      if (image) { image.onload = null; image.onerror = null; image.removeAttribute("src"); }
      texture?.dispose(); geometry?.dispose(); material?.dispose();
      if (renderer) {
        renderer.domElement.removeEventListener("webglcontextlost", contextLost);
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      }
    };
  }, [src, kind]);

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    event.preventDefault(); event.stopPropagation();
    const points = [...pointers.current.values()], before = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const next = [...pointers.current.values()], after = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
      if (before > 0 && after > 0) zoom(before / after);
    } else if (pointers.current.size === 1) {
      const sensitivity = viewRef.current.fov / Math.max(1, event.currentTarget.clientHeight);
      changeView({ ...viewRef.current, yaw: viewRef.current.yaw - (event.clientX - previous.x) * sensitivity, pitch: viewRef.current.pitch + (event.clientY - previous.y) * sensitivity });
    }
  }
  function pointerEnd(event: React.PointerEvent<HTMLDivElement>) { pointers.current.delete(event.pointerId); }

  return <div ref={root} className="panorama-viewer" data-testid="panorama-viewer" data-ready={ready ? "true" : "false"} aria-label={title ? translateUI("360° 全景：{0}", [title]) : translateUI("360° 全景")}>
    <div ref={viewport} className="panorama-viewport" data-testid="panorama-viewport" role="group" tabIndex={0} aria-label={translateUI("全景视角，拖动或使用方向键环顾，滚轮或加减号缩放")} data-yaw={view.yaw} data-pitch={view.pitch} data-fov={view.fov}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
      onDragStart={event => event.preventDefault()} onKeyDown={event => {
        const value = viewRef.current;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home", "0"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (["Home", "0"].includes(event.key)) changeView({ ...initialView });
          else if (["+", "=", "-"].includes(event.key)) zoom(event.key === "-" ? 1.15 : 1 / 1.15);
          else changeView({ ...value, yaw: value.yaw + (event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0), pitch: value.pitch + (event.key === "ArrowUp" ? 5 : event.key === "ArrowDown" ? -5 : 0) });
        } else if (event.key === " " && kind === "video") { event.preventDefault(); event.stopPropagation(); void play(); }
      }}>
      {!ready && !error && <p className="panorama-status" role="status">{kind === "video" ? translateUI("正在载入全景视频，可点击播放…") : translateUI("正在载入全景图片…")}</p>}
      {error && <div className="panorama-status panorama-error"><p role="alert">{error}</p><a href={src} target="_blank" rel="noopener noreferrer">{translateUI("打开原件")}</a></div>}
    </div>
    {kind === "video" && <video ref={video} className="panorama-video-source" playsInline preload="metadata" aria-label={translateUI("全景视频播放器")}/>}
    <div className="panorama-controls" role="group" aria-label={translateUI("全景控制")} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (!["Escape", "Tab"].includes(event.key)) event.stopPropagation(); }}>
      {kind === "video" && <>
        <button type="button" aria-label={playing ? translateUI("暂停全景视频") : translateUI("播放全景视频")} disabled={!!error} onClick={() => void play()}>{playing ? translateUI("暂停") : translateUI("播放")}</button>
        <input className="panorama-seek" type="range" aria-label={translateUI("全景视频进度")} min={0} max={duration || 1} step={.1} value={Math.min(time, duration || 1)} disabled={!duration || !!error} onChange={event => {
          const element = video.current;
          if (element && duration) {
            try { element.currentTime = Number(event.target.value); setTime(element.currentTime); }
            catch { setNotice(translateUI("当前位置暂时无法跳转，请等待视频载入后重试。")); }
          }
        }}/>
        <span className="panorama-time">{timestamp(time)} / {duration ? timestamp(duration) : "--:--"}</span>
        <label className="panorama-volume">{translateUI("音量")}<input type="range" aria-label={translateUI("全景视频音量")} min={0} max={1} step={.05} value={volume} onChange={event => {
          const value = Number(event.target.value); volumeRef.current = value; setVolume(value); if (video.current) { video.current.volume = value; video.current.muted = value === 0; }
        }}/></label>
      </>}
      <button type="button" aria-label={translateUI("缩小全景")} title={translateUI("缩小视角")} onClick={() => zoom(1.15)}>−</button>
      <button type="button" aria-label={translateUI("放大全景")} title={translateUI("放大视角")} onClick={() => zoom(1 / 1.15)}>＋</button>
      <button type="button" aria-label={translateUI("视角复位")} onClick={() => changeView({ ...initialView })}>{translateUI("复位")}</button>
      <button type="button" aria-label={translateUI("全景全屏")} onClick={() => void fullscreen()}>{translateUI("全屏")}</button>
      <span className="panorama-help">{translateUI("拖动环顾 · 滚轮缩放")}</span>
    </div>
    {notice && !error && <p className="panorama-notice" role="status">{notice}</p>}
  </div>;
}

export default PanoramaViewer;
