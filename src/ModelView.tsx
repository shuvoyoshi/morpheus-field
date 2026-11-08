/**
 * A GLB on a turntable you can grab: three.js, orbit controls, image-based
 * light from a neutral room so the PBR maps read as they will in any engine.
 * The model is framed by its bounds, so any scale TRELLIS.2 (or anything else)
 * hands us fits the view. Until the file has loaded, the poster shows.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type ModelLook = 'lit' | 'clay' | 'wire';

export default function ModelView({ src, poster, look = 'lit', spin = true, className, style }: {
  src: string;
  poster?: string;
  look?: ModelLook;
  spin?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [stats, setStats] = useState<{ tris: number; size: string } | null>(null);
  const lookRef = useRef(look);
  const spinRef = useRef(spin);
  const applyLook = useRef<(l: ModelLook) => void>(() => {});
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      setState('error');
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 2);
    scene.add(key);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(0, 0.25, 2.2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = spinRef.current;
    controls.autoRotateSpeed = 1.6;
    controlsRef.current = controls;
    // Grabbing the model stops the spin for good; it is theirs now.
    controls.addEventListener('start', () => { controls.autoRotate = false; });

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // Materials as loaded, plus the two inspection looks.
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const clay = new THREE.MeshStandardMaterial({ color: 0x9a948b, roughness: 0.8, metalness: 0 });
    const wire = new THREE.MeshBasicMaterial({ color: 0xff6600, wireframe: true });
    applyLook.current = (l) => {
      for (const [mesh, mat] of originals) mesh.material = l === 'clay' ? clay : l === 'wire' ? wire : mat;
    };

    let dead = false;
    let model: THREE.Object3D | null = null;
    new GLTFLoader().load(
      src,
      (gltf) => {
        if (dead) return;
        model = gltf.scene;
        let tris = 0;
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          originals.set(m, m.material);
          const g = m.geometry;
          tris += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        });
        // Center on the bounds and scale to a unit-ish size.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
        model.position.sub(center);
        const pivot = new THREE.Group();
        pivot.add(model);
        pivot.scale.setScalar(0.5 / radius);
        scene.add(pivot);
        const dist = 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25;
        camera.position.set(0, dist * 0.22, dist);
        controls.target.set(0, 0, 0);
        controls.minDistance = dist * 0.25;
        controls.maxDistance = dist * 4;
        controls.update();
        applyLook.current(lookRef.current);
        setStats({ tris: Math.round(tris), size: `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}` });
        setState('ready');
      },
      undefined,
      () => { if (!dead) setState('error'); },
    );

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
      for (const mat of originals.values()) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      clay.dispose();
      wire.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src]);

  useEffect(() => { lookRef.current = look; applyLook.current(look); }, [look]);
  useEffect(() => { spinRef.current = spin; if (controlsRef.current) controlsRef.current.autoRotate = spin; }, [spin]);

  return (
    <div className={`model-view ${className ?? ''}`} style={style} data-state={state}>
      <div ref={host} className="model-canvas" />
      {state !== 'ready' && poster && <img className="model-poster" src={poster} alt="" />}
      {state === 'loading' && <span className="badge model-note">Loading the model...</span>}
      {state === 'error' && <span className="badge model-note">This browser could not show the model. Download the GLB to open it elsewhere.</span>}
      {stats && <span className="model-stats mono">{stats.tris.toLocaleString()} triangles</span>}
    </div>
  );
}
