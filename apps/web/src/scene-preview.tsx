import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

export default function ScenePreview({ asset }: { asset: any }) {
  const host = useRef<HTMLDivElement>(null),
    [status, setStatus] = useState(translateUI("正在读取场景…")),
    [error, setError] = useState("");
  useEffect(() => {
    let closed = false,
      renderer: THREE.WebGLRenderer | undefined,
      controls: OrbitControls | undefined,
      observer: ResizeObserver | undefined,
      frame = 0,
      scene: THREE.Scene | undefined,
      splat: any,
      spark: any;
    const controller = new AbortController();
    async function load() {
      try {
        const container = host.current!;
        renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.setClearColor("#18251f");
        container.appendChild(renderer.domElement);
        scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x667766, 3));
        const light = new THREE.DirectionalLight(0xffffff, 3);
        light.position.set(3, 5, 4);
        scene.add(light);
        const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 10000);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        observer = new ResizeObserver(() => {
          if (!renderer || closed) return;
          const width = container.clientWidth,
            height = container.clientHeight;
          renderer.setSize(width, height);
          camera.aspect = width / Math.max(1, height);
          camera.updateProjectionMatrix();
        });
        observer.observe(container);
        renderer.setSize(container.clientWidth, container.clientHeight);
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        let object: THREE.Object3D,
          box: THREE.Box3,
          count = 0;
        if (asset.kind === "gaussian") {
          const { SparkRenderer, SplatMesh, SplatFileType } = await import(
            "@sparkjsdev/spark"
          );
          if (closed) return;
          spark = new SparkRenderer({ renderer });
          scene.add(spark);
          const response = await fetch(asset.url, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(translateUI("无权读取此场景或资源已不可用"));
          const fileBytes = await response.arrayBuffer();
          if (closed) return;
          if (asset.metadata.format === "ply") {
            const header = new TextDecoder()
              .decode(fileBytes.slice(0, 65536))
              .split("end_header")[0];
            if (!header.includes("format binary_little_endian 1.0"))
              throw new Error(
                translateUI("高斯 PLY 预览支持 binary_little_endian 格式，请转换后上传；原文件仍可下载"),
              );
            const vertices = Number(header.match(/element vertex (\d+)/)?.[1]);
            if (
              !Number.isSafeInteger(vertices) ||
              vertices < 1 ||
              vertices > 5_000_000 ||
              vertices > fileBytes.byteLength / 12
            )
              throw new Error(translateUI("高斯 PLY 顶点数无效或超过预览上限"));
          }
          splat = new SplatMesh({
            fileBytes,
            fileType:
              asset.metadata.format === "splat"
                ? SplatFileType.SPLAT
                : SplatFileType.PLY,
            lod: false,
          });
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              splat.initialized,
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        translateUI("高斯场景解析超时，请检查文件格式或尝试精简场景"),
                      ),
                    ),
                  30000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
          if (closed) {
            splat.dispose();
            return;
          }
          splat.rotation.x = Math.PI;
          object = splat;
          count = splat.splats?.getNumSplats() || 0;
          object.updateMatrixWorld(true);
          box = splat.getBoundingBox().applyMatrix4(object.matrixWorld);
        } else {
          const response = await fetch(asset.url, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(translateUI("场景读取失败"));
          const bytes = await response.arrayBuffer();
          if (closed) return;
          if (asset.metadata.format === "ply") {
            const header = new TextDecoder()
                .decode(bytes.slice(0, 65536))
                .split("end_header")[0],
              count = Number(header.match(/element vertex (\d+)/)?.[1]);
            if (
              !Number.isSafeInteger(count) ||
              count < 1 ||
              count > 10_000_000 ||
              count > bytes.byteLength / 3
            )
              throw new Error(translateUI("PLY 顶点数无效或超过预览上限，请上传精简场景"));
          }
          if (asset.metadata.format === "glb") {
            const manager = new THREE.LoadingManager();
            // Self-contained GLB only. Embedded uploaded content must not cause arbitrary authenticated requests.
            manager.setURLModifier((url) => {
              if (!url.startsWith("blob:") && !url.startsWith("data:"))
                throw new Error(translateUI("GLB 包含外部依赖，请嵌入贴图后重新导出"));
              return url;
            });
            object = (await new GLTFLoader(manager).parseAsync(bytes, ""))
              .scene;
          } else if (asset.metadata.format === "obj")
            object = new OBJLoader().parse(new TextDecoder().decode(bytes));
          else {
            const geometry = new PLYLoader().parse(bytes);
            if (asset.kind === "pointcloud")
              object = new THREE.Points(
                geometry,
                new THREE.PointsMaterial({
                  size: 0.015,
                  vertexColors: !!geometry.getAttribute("color"),
                  color: geometry.getAttribute("color") ? 0xffffff : 0xa8d9b8,
                }),
              );
            else {
              geometry.computeVertexNormals();
              object = new THREE.Mesh(
                geometry,
                new THREE.MeshStandardMaterial({
                  color: geometry.getAttribute("color") ? 0xffffff : 0x9ac8b5,
                  vertexColors: !!geometry.getAttribute("color"),
                  side: THREE.DoubleSide,
                }),
              );
            }
          }
          object.traverse((child) => {
            const geometry = (child as THREE.Mesh).geometry;
            if (geometry)
              count += geometry.getAttribute("position")?.count || 0;
          });
          object.updateMatrixWorld(true);
          box = new THREE.Box3().setFromObject(object);
        }
        if (closed) {
          disposeObject(object);
          return;
        }
        if (
          box.isEmpty() ||
          ![
            box.min.x,
            box.min.y,
            box.min.z,
            box.max.x,
            box.max.y,
            box.max.z,
          ].every(Number.isFinite)
        )
          throw new Error(translateUI("场景没有有效几何数据"));
        scene.add(object);
        const center = box.getCenter(new THREE.Vector3()),
          radius = Math.max(
            box.getSize(new THREE.Vector3()).length() / 2,
            0.05,
          );
        controls.target.copy(center);
        camera.position
          .copy(center)
          .add(
            new THREE.Vector3(0.3, 0.2, 1)
              .normalize()
              .multiplyScalar(radius * 2.8),
          );
        camera.near = Math.max(radius / 10000, 0.000001);
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        controls.update();
        const caption =
          asset.kind === "gaussian"
            ? translateUI("{0} 个高斯椭球", [count.toLocaleString(uiLocale())])
            : translateUI("{0} 个顶点", [count.toLocaleString(uiLocale())]);
        let rendered = 0;
        const draw = () => {
          if (closed || !renderer || !scene) return;
          controls?.update();
          renderer.render(scene, camera);
          if (++rendered === 12) setStatus(translateUI("已渲染 · {0}", [caption]));
          frame = requestAnimationFrame(draw);
        };
        draw();
      } catch (error) {
        if (!closed) {
          setError(translateUI(error instanceof Error ? error.message : String(error)));
          setStatus(translateUI("场景未能载入"));
        }
      }
    }
    void load();
    return () => {
      closed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controls?.dispose();
      if (scene) disposeObject(scene);
      splat?.dispose();
      spark?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };
  }, [asset.id]);
  return (
    <div className="scene-viewer">
      <div ref={host} className="scene-canvas" aria-label={translateUI("3D 场景画布")} />
      <div className="scene-status" role="status">
        {status}
        <small>{translateUI("拖动旋转 · 滚轮缩放 · 右键平移")}</small>
      </div>
      {error && (
        <div className="scene-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      if (material) {
        for (const value of Object.values(material))
          if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
  });
}
