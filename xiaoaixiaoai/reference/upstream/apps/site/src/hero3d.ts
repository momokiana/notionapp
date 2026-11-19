// Living hero background: a pastel shader sky plus floating glossy keycaps,
// wool clouds, rings, hearts and sparkles. Loaded lazily; skipped for reduced motion.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uDark;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 1.6;
  float t = uTime * 0.045;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 1.3), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t));
  float n = fbm(p + 2.5 * r);

  vec3 base = mix(vec3(1.0, 0.965, 0.976), vec3(0.11, 0.09, 0.133), uDark);
  vec3 pink = mix(vec3(1.0, 0.82, 0.89), vec3(0.36, 0.15, 0.29), uDark);
  vec3 lav  = mix(vec3(0.91, 0.87, 1.0), vec3(0.22, 0.16, 0.34), uDark);
  vec3 mint = mix(vec3(0.86, 0.96, 0.92), vec3(0.11, 0.2, 0.18), uDark);
  vec3 peach= mix(vec3(1.0, 0.91, 0.86), vec3(0.27, 0.16, 0.2), uDark);

  vec3 col = base;
  col = mix(col, pink, smoothstep(0.35, 0.8, n) * 0.95);
  col = mix(col, lav, smoothstep(0.3, 0.75, q.x) * 0.7);
  col = mix(col, mint, smoothstep(0.55, 0.9, r.y) * 0.45);
  col = mix(col, peach, smoothstep(0.6, 0.95, q.y) * 0.35);

  // keep the text column (left) calmer and lighter
  float calm = smoothstep(0.62, 0.05, uv.x) * 0.55;
  col = mix(col, base, calm);

  // soft glow following the pointer
  vec2 m = uMouse;
  float d = distance(uv * vec2(uRes.x / uRes.y, 1.0), m * vec2(uRes.x / uRes.y, 1.0));
  col += mix(vec3(1.0, 0.75, 0.86), vec3(0.6, 0.25, 0.45), uDark) * 0.10 * smoothstep(0.55, 0.0, d);

  // fade into the page at the bottom
  col = mix(base, col, smoothstep(0.0, 0.22, uv.y));
  // grain
  col += (hash(uv * uRes + uTime) - 0.5) * 0.018;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface Floater {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  spin: THREE.Vector3;
  bob: number;
  phase: number;
  scatter: THREE.Vector3;
  press?: number;
}

function labelTexture(text: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const size = text.length > 2 ? 78 : 112;
  g.font = `700 ${size}px "Maple Mono", ui-monospace, Menlo, monospace`;
  g.fillText(text, 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function starShape(points = 4, outer = 0.5, inner = 0.17): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.quadraticCurveTo(Math.cos(a - Math.PI / (points * 2)) * inner * 0.9, Math.sin(a - Math.PI / (points * 2)) * inner * 0.9, x, y);
  }
  return s;
}

function heartShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, -0.35);
  s.bezierCurveTo(-0.08, -0.26, -0.5, 0.0, -0.45, 0.22);
  s.bezierCurveTo(-0.4, 0.45, -0.1, 0.48, 0, 0.28);
  s.bezierCurveTo(0.1, 0.48, 0.4, 0.45, 0.45, 0.22);
  s.bezierCurveTo(0.5, 0.0, 0.08, -0.26, 0, -0.35);
  return s;
}

export function startHero3D(host: HTMLElement): () => void {
  const isSmall = window.innerWidth < 760;
  // Default GPU (no switch to a discrete one) and at most 1.25 device pixels per
  // CSS pixel: the soft sky looks the same, at well under the old fill cost.
  const renderer = new THREE.WebGLRenderer({ antialias: !isSmall, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.autoClear = false;
  host.appendChild(renderer.domElement);

  // ---- sky
  const skyScene = new THREE.Scene();
  const skyCam = new THREE.Camera();
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMouse: { value: new THREE.Vector2(0.7, 0.6) },
      uDark: { value: 0 },
    },
    depthWrite: false,
    depthTest: false,
  });
  skyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat));

  // ---- objects
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 14);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const hemi = new THREE.HemisphereLight(0xfff0f6, 0xc9b6f7, 1.25);
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(4, 6, 8);
  const rim = new THREE.PointLight(0xff8fb8, 30, 30);
  rim.position.set(-6, -4, 4);
  scene.add(hemi, key, rim);

  const floaters: Floater[] = [];
  const keycaps: THREE.Object3D[] = [];
  const add = (obj: THREE.Object3D, x: number, y: number, z: number, opts: Partial<Floater> = {}) => {
    obj.position.set(x, y, z);
    scene.add(obj);
    const f: Floater = {
      obj,
      base: new THREE.Vector3(x, y, z),
      spin: opts.spin ?? new THREE.Vector3(Math.random() * 0.3, Math.random() * 0.4, Math.random() * 0.2),
      bob: opts.bob ?? 0.25 + Math.random() * 0.25,
      phase: Math.random() * Math.PI * 2,
      scatter: new THREE.Vector3(Math.sign(x || 1) * (2 + Math.random() * 3), 3 + Math.random() * 3, Math.random() * 2),
    };
    floaters.push(f);
    return f;
  };

  // Keycaps with labels
  const capGeo = new RoundedBoxGeometry(1, 1, 0.5, 4, 0.2);
  const capColors = [0xffb8d2, 0xd9c8ff, 0xc6efdf, 0xffd8c4, 0xffc9dc];
  const capLabels = [">_", "Esc", "Tab", "^C", "Enter"];
  const capPos: [number, number, number, number][] = isSmall
    ? [
        [-3.2, 4.6, -1, 0.9],
        [3.4, 5.2, -2, 0.8],
        [-3.6, -4.8, -1.5, 0.8],
      ]
    : [
        [-9.6, 3.0, -2, 1.1],
        [10.4, 2.6, -3, 1.0],
        [1.2, -4.4, -4, 0.8],
        [-7.4, -4.4, -1, 0.95],
        [9.6, -3.6, -1.5, 1.05],
      ];
  capPos.forEach(([x, y, z, s], i) => {
    const g = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({
      color: capColors[i % capColors.length],
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffffff),
    });
    const body = new THREE.Mesh(capGeo, mat);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.82, 0.82),
      new THREE.MeshBasicMaterial({ map: labelTexture(capLabels[i % capLabels.length], "#4a3550"), transparent: true, toneMapped: false }),
    );
    label.position.z = 0.256;
    g.add(body, label);
    g.scale.setScalar(s);
    g.rotation.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.6);
    const f = add(g, x, y, z, { spin: new THREE.Vector3(0.12, 0.22, 0.05) });
    f.press = 0;
    keycaps.push(g);
  });

  // Wool clouds
  const woolMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, emissive: 0xffd6e6, emissiveIntensity: 0.12 });
  const ball = new THREE.IcosahedronGeometry(1, 3);
  const cloud = (scale: number) => {
    const g = new THREE.Group();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(ball, woolMat);
      const a = (i / n) * Math.PI * 2;
      const r = i === 0 ? 0 : 0.75 + Math.random() * 0.25;
      m.position.set(Math.cos(a) * r * 1.4, Math.sin(a) * r * 0.45 + (i === 0 ? 0.25 : 0), (Math.random() - 0.5) * 0.4);
      m.scale.setScalar(i === 0 ? 0.95 : 0.55 + Math.random() * 0.3);
      g.add(m);
    }
    g.scale.setScalar(scale);
    return g;
  };
  const cloudPos: [number, number, number, number][] = isSmall
    ? [
        [-4.2, 2.2, -6, 0.9],
        [4.4, -2.6, -7, 1.1],
      ]
    : [
        [-12, 0.2, -8, 1.2],
        [12.5, -0.6, -7, 1.3],
        [-1.5, -6.6, -10, 1.0],
        [5.5, 5.4, -12, 1.0],
      ];
  for (const [x, y, z, s] of cloudPos) add(cloud(s), x, y, z, { spin: new THREE.Vector3(0, 0.05, 0), bob: 0.35 });

  // Rings
  const ringGeo = new THREE.TorusGeometry(0.55, 0.17, 24, 64);
  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0xc9b6f7, roughness: 0.25, clearcoat: 1, metalness: 0.05 });
  if (!isSmall) {
    add(new THREE.Mesh(ringGeo, ringMat), -11.2, -2.2, -3);
    add(new THREE.Mesh(ringGeo, new THREE.MeshPhysicalMaterial({ color: 0xffb3cf, roughness: 0.25, clearcoat: 1, metalness: 0.05 })), 7.2, 4.0, -5);
  }

  // Stars and hearts
  const extrude = { depth: 0.18, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 4, curveSegments: 16 };
  const starGeo = new THREE.ExtrudeGeometry(starShape(), extrude);
  starGeo.center();
  const heartGeo = new THREE.ExtrudeGeometry(heartShape(), extrude);
  heartGeo.center();
  const starMat = new THREE.MeshPhysicalMaterial({ color: 0xffd36e, roughness: 0.3, clearcoat: 1, emissive: 0xffb84d, emissiveIntensity: 0.12 });
  const heartMat = new THREE.MeshPhysicalMaterial({ color: 0xff7eaa, roughness: 0.28, clearcoat: 1 });
  const smallPos: [THREE.BufferGeometry, THREE.Material, number, number, number, number][] = isSmall
    ? [
        [starGeo, starMat, 3.6, 2.2, -2, 1.1],
        [heartGeo, heartMat, -3.4, -1.8, -2, 1.1],
      ]
    : [
        [starGeo, starMat, -3.2, 4.2, -5, 1.2],
        [starGeo, starMat, 11.2, 0.4, -4, 1.0],
        [starGeo, starMat, -10.4, -5.0, -4, 0.9],
        [heartGeo, heartMat, 4.6, -5.0, -2, 1.2],
        [heartGeo, heartMat, -12.5, 3.8, -6, 1.0],
      ];
  for (const [g, m, x, y, z, s] of smallPos) {
    const mesh = new THREE.Mesh(g, m);
    mesh.scale.setScalar(s);
    add(mesh, x, y, z, { spin: new THREE.Vector3(0.1, 0.5, 0.15) });
  }

  // Sparkles
  const N = isSmall ? 60 : 140;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 16;
    pos[i * 3 + 2] = -2 - Math.random() * 10;
    seed[i] = Math.random();
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pg.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  const sparkMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uDark: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float seed; uniform float uTime; uniform float uPx; varying float vA;
      void main() {
        vec3 p = position;
        p.y += mod(uTime * (0.15 + seed * 0.25) + seed * 16.0, 16.0) - 8.0 - position.y * 0.0;
        p.x += sin(uTime * 0.6 + seed * 20.0) * 0.3;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = 0.35 + 0.65 * abs(sin(uTime * (1.0 + seed * 2.0) + seed * 30.0));
        gl_PointSize = (6.0 + seed * 10.0) * uPx * (10.0 / -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; uniform float uDark;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float star = max(0.0, 1.0 - d * 2.0);
        float cross = max(0.0, 1.0 - abs(c.x) * 14.0) * max(0.0, 1.0 - abs(c.y) * 2.2) + max(0.0, 1.0 - abs(c.y) * 14.0) * max(0.0, 1.0 - abs(c.x) * 2.2);
        float a = (pow(star, 3.0) + cross * 0.6) * vA;
        vec3 col = mix(vec3(1.0, 0.62, 0.78), vec3(1.0, 0.75, 0.88), uDark);
        gl_FragColor = vec4(col, a * mix(0.75, 0.9, uDark));
      }`,
  });
  scene.add(new THREE.Points(pg, sparkMat));

  // ---- state
  const mouse = new THREE.Vector2(0, 0);
  const mouseSmooth = new THREE.Vector2(0, 0);
  const ndc = new THREE.Vector2(-9, -9);
  const ray = new THREE.Raycaster();
  let scroll = 0;
  let running = true;
  let dead = false;
  let raf = 0;
  const timer = new THREE.Timer();

  const applyTheme = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    skyMat.uniforms.uDark.value = dark ? 1 : 0;
    sparkMat.uniforms.uDark.value = dark ? 1 : 0;
    hemi.intensity = dark ? 0.7 : 1.25;
    key.intensity = dark ? 1.2 : 1.7;
    woolMat.emissiveIntensity = dark ? 0.04 : 0.12;
    woolMat.color.set(dark ? 0xe8d4e2 : 0xffffff);
    renderer.toneMappingExposure = dark ? 0.95 : 1.05;
  };
  applyTheme();
  const themeObs = new MutationObserver(applyTheme);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const resize = () => {
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    // keep the composition: wider screens see more horizontally
    camera.fov = w / hgt < 1 ? 52 : 38;
    camera.updateProjectionMatrix();
    skyMat.uniforms.uRes.value.set(w, hgt);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const hero = host.parentElement!;
  const onMove = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    mouse.set(x * 2 - 1, -(y * 2 - 1));
    ndc.copy(mouse);
    skyMat.uniforms.uMouse.value.set(x, 1 - y);
  };
  hero.addEventListener("pointermove", onMove);
  hero.addEventListener("pointerleave", () => ndc.set(-9, -9));
  const onScroll = () => {
    scroll = Math.min(1, Math.max(0, window.scrollY / Math.max(1, hero.offsetHeight)));
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  const io = new IntersectionObserver(([e]) => {
    running = !dead && e.isIntersecting && !document.hidden;
    if (running) loop();
  });
  io.observe(host);
  const onVis = () => {
    running = !dead && !document.hidden && host.getBoundingClientRect().bottom > 0;
    if (running) loop();
  };
  document.addEventListener("visibilitychange", onVis);

  const tmp = new THREE.Vector3();
  const frame = () => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const time = timer.getElapsed();
    skyMat.uniforms.uTime.value = time;
    sparkMat.uniforms.uTime.value = time;
    mouseSmooth.lerp(mouse, 0.04);
    camera.position.x = mouseSmooth.x * 0.7;
    camera.position.y = mouseSmooth.y * 0.45 - scroll * 1.5;
    camera.lookAt(0, -scroll * 1.5, 0);

    // hover-press keycaps
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(keycaps, true)[0];
    let hitRoot: THREE.Object3D | null = null;
    if (hit) {
      hitRoot = hit.object;
      while (hitRoot && !keycaps.includes(hitRoot)) hitRoot = hitRoot.parent;
    }

    for (const f of floaters) {
      const k = Math.sin(time * 0.8 + f.phase);
      tmp.copy(f.base).addScaledVector(f.scatter, scroll * scroll * 1.6);
      tmp.y += k * f.bob;
      f.obj.position.copy(tmp);
      f.obj.rotation.x += f.spin.x * dt;
      f.obj.rotation.y += f.spin.y * dt;
      f.obj.rotation.z += f.spin.z * dt * 0.5;
      if (f.press !== undefined) {
        const target = f.obj === hitRoot ? 1 : 0;
        f.press += (target - f.press) * 0.15;
        const s = (f.obj.userData.s ??= f.obj.scale.x) as number;
        f.obj.scale.set(s * (1 + f.press * 0.12), s * (1 + f.press * 0.12), s * (1 - f.press * 0.35));
      }
    }
    renderer.clear();
    renderer.render(skyScene, skyCam);
    renderer.render(scene, camera);
  };
  // A machine that can't hold about 40 fps here gets the CSS gradient instead:
  // of the first 120 on-screen frames, more than half slower than 25 ms ends the scene.
  let sampled = 0;
  let slow = 0;
  let lastT = 0;
  const loop = () => {
    cancelAnimationFrame(raf);
    if (!running) return;
    const now = performance.now();
    if (sampled < 120 && lastT && now - lastT < 250) {
      sampled++;
      if (now - lastT > 25) slow++;
      if (sampled === 120 && slow > 60) {
        renderer.domElement.classList.remove("is-ready");
        setTimeout(stop, 1300);
        dead = running = false;
        return;
      }
    }
    lastT = now;
    frame();
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    dead = true;
    running = false;
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    themeObs.disconnect();
    window.removeEventListener("scroll", onScroll);
    hero.removeEventListener("pointermove", onMove);
    document.removeEventListener("visibilitychange", onVis);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };

  frame();
  renderer.domElement.classList.add("is-ready");
  loop();
  return stop;
}
