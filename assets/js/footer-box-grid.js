/**
 * Lumora Portfolio — Interactive 3D Diamond Box Grid Engine
 * Powered by Three.js InstancedMesh
 * Inspired by Framer Marketplace "Interactive Box Grid"
 * 
 * Features:
 * - Tightly packed, rounded diamond squircle 3D tiles with visible thickness and beveled edges
 * - Gentle oblique perspective view angle matching the reference
 * - Subtle monochrome vector glyphs (✦ sparkle, ✳ asterisk, ✴ burst, ✺ spiral) on selected tiles
 * - Reference color palette: near-black charcoal tiles with soft white/pale pink center,
 *   radiant magenta/pink midtones, and muted mauve/violet peripheral iridescence
 * - Damped harmonic spring physics (wave ripple + Gaussian proximity lift + neighbor slope tilts)
 * - Dynamic cursor point light casting soft pink/white illumination
 * - Automatic pause via IntersectionObserver when footer is offscreen
 * - Non-blocking pointer events preserving all footer links and text
 */

(function () {
  'use strict';

  // Physics constants
  const SPRING_K = 140.0;
  const SPRING_DAMP = 14.0;
  const MAX_RIPPLES = 8;
  const CAMERA_TILT_DEG = 26; // Gentle oblique downward angle matching reference

  class InteractiveBoxGrid {
    constructor(footerEl, options = {}) {
      if (!footerEl) return;
      this.footer = footerEl;
      this.canvas = footerEl.querySelector('#footer-box-grid-canvas');
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'footer-box-grid-canvas';
        this.canvas.className = 'footer-box-grid-canvas';
        this.canvas.setAttribute('aria-hidden', 'true');
        this.footer.insertBefore(this.canvas, this.footer.firstChild);
      }

      this.options = Object.assign({
        tileSizeDesktop: 52,
        tileSizeMobile: 38,
        tileRadiusDesktop: 12,
        tileRadiusMobile: 9,
        tileDepth: 11,
        bevelSize: 2.4,
        bevelThickness: 2.4,
        gapDesktop: 7.5,
        gapMobile: 6.0,
        peakLift: 26,
        waveRadiusDesktop: 240,
        waveRadiusMobile: 170,
        waveSpeed: 340,
        ambientAmplitude: 2.8,
        ambientSpeed: 0.95
      }, options);

      // State
      this.width = 0;
      this.height = 0;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.isVisible = false;
      this.isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.rafId = null;
      this.lastTime = performance.now();

      // Mouse tracking
      this.mouse = {
        screenX: -9999,
        screenY: -9999,
        worldX: -9999,
        worldY: -9999,
        targetWorldX: -9999,
        targetWorldY: -9999,
        intensity: 0,
        targetIntensity: 0,
        prevWorldX: -9999,
        prevWorldY: -9999,
        speed: 0
      };

      this.ripples = [];
      this.tiles = [];
      this.iconMeshes = [];
      this.iconInstances = [[], [], [], []];

      this.init();
    }

    init() {
      if (typeof THREE === 'undefined') {
        console.warn('Three.js not loaded, interactive 3D box grid unavailable.');
        return;
      }

      this.setupThree();
      this.setupIcons();
      this.setupEvents();
      this.handleResize();
      this.setupObserver();
      this.start();
    }

    setupThree() {
      // Scene
      this.scene = new THREE.Scene();

      // Perspective Camera (gentle oblique pitch)
      this.camera = new THREE.PerspectiveCamera(36, 1, 1, 5000);

      // WebGL Renderer
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance'
      });
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setClearColor(0x000000, 0);

      // Lighting Setup matching reference:
      // 1) Ambient Light: Ensures resting tiles have rich, dark charcoal presence
      this.ambientLight = new THREE.AmbientLight(0x353a48, 2.2);
      this.scene.add(this.ambientLight);

      // 2) Directional Key Light: Angled from upper-front for subtle bevel highlights
      this.dirLight = new THREE.DirectionalLight(0xffffff, 2.4);
      this.dirLight.position.set(160, -320, 520);
      this.scene.add(this.dirLight);

      // 3) Cursor Dynamic Point Light: Soft pink-white that tracks pointer
      this.cursorPointLight = new THREE.PointLight(0xf472b6, 0, 460);
      this.cursorPointLight.position.set(0, 0, 75);
      this.scene.add(this.cursorPointLight);

      // 4) Subtle Peripheral Rim Light (soft mauve)
      this.rimLight = new THREE.PointLight(0xa855f7, 0.7, 650);
      this.rimLight.position.set(-300, 250, 150);
      this.scene.add(this.rimLight);

      // Raycaster & Ground Plane (Z = 0)
      this.raycaster = new THREE.Raycaster();
      this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      this.mouseNdc = new THREE.Vector2(-9999, -9999);
      this.raycastPos = new THREE.Vector3();

      // Matrix computation dummy
      this.dummy = new THREE.Object3D();

      // Exact Reference Color Palette:
      this.colorBase = new THREE.Color(0x0f1116);      // Deep near-black obsidian charcoal
      this.colorWhite = new THREE.Color(0xffffff);     // Luminous white core
      this.colorPalePink = new THREE.Color(0xfde2e8);  // Soft pale pink peak
      this.colorPink = new THREE.Color(0xf472b6);      // Radiant bright pink
      this.colorMagenta = new THREE.Color(0xdb2777);   // Midtone vibrant magenta
      this.colorCyan = new THREE.Color(0x38bdf8);      // Subtle sky/cyan iridescent accent
      this.colorMauve = new THREE.Color(0x701a75);     // Peripheral muted mauve / deep violet

      this.colorIconBase = new THREE.Color(0x525666); // Faint muted silver at rest
      this.colorIconLit = new THREE.Color(0xffffff);  // Crisp white when illuminated

      this.tempColor = new THREE.Color();
      this.tempIconColor = new THREE.Color();
    }

    setupIcons() {
      // Create 4 procedural vector symbol textures (64x64 canvas)
      const createTexture = (drawFn) => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 64, 64);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        drawFn(ctx);
        const tex = new THREE.CanvasTexture(c);
        tex.needsUpdate = true;
        return tex;
      };

      // 0: ✦ 4-point concave sparkle star
      const texSparkle = createTexture((ctx) => {
        ctx.beginPath();
        ctx.moveTo(32, 10);
        ctx.quadraticCurveTo(32, 28, 54, 32);
        ctx.quadraticCurveTo(32, 36, 32, 54);
        ctx.quadraticCurveTo(32, 36, 10, 32);
        ctx.quadraticCurveTo(32, 28, 32, 10);
        ctx.fill();
      });

      // 1: ✳ 8-ray asterisk
      const texAsterisk = createTexture((ctx) => {
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (let a = 0; a < 8; a++) {
          const ang = (a * Math.PI) / 4;
          ctx.beginPath();
          ctx.moveTo(32 + Math.cos(ang) * 5, 32 + Math.sin(ang) * 5);
          ctx.lineTo(32 + Math.cos(ang) * 19, 32 + Math.sin(ang) * 19);
          ctx.stroke();
        }
      });

      // 2: ✴ 12-ray radial starburst
      const texBurst = createTexture((ctx) => {
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        for (let a = 0; a < 12; a++) {
          const ang = (a * Math.PI) / 6;
          ctx.beginPath();
          ctx.moveTo(32 + Math.cos(ang) * 5, 32 + Math.sin(ang) * 5);
          ctx.lineTo(32 + Math.cos(ang) * 18, 32 + Math.sin(ang) * 18);
          ctx.stroke();
        }
      });

      // 3: ✺ Interlocking petal spiral
      const texSpiral = createTexture((ctx) => {
        ctx.lineWidth = 2.6;
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          ctx.beginPath();
          ctx.arc(32 + Math.cos(ang) * 7, 32 + Math.sin(ang) * 7, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      });

      this.iconTextures = [texSparkle, texAsterisk, texBurst, texSpiral];
      this.iconMaterials = this.iconTextures.map(tex => new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      }));

      this.iconGeo = new THREE.PlaneGeometry(16, 16);
    }

    setupEvents() {
      const onPointerMove = (e) => {
        const rect = this.footer.getBoundingClientRect();
        this.mouse.screenX = e.clientX - rect.left;
        this.mouse.screenY = e.clientY - rect.top;

        this.mouseNdc.x = (this.mouse.screenX / rect.width) * 2 - 1;
        this.mouseNdc.y = -(this.mouse.screenY / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouseNdc, this.camera);
        if (this.raycaster.ray.intersectPlane(this.groundPlane, this.raycastPos)) {
          this.mouse.targetWorldX = this.raycastPos.x;
          this.mouse.targetWorldY = this.raycastPos.y;
          this.mouse.targetIntensity = 1.0;

          if (this.mouse.prevWorldX !== -9999) {
            const dx = this.mouse.targetWorldX - this.mouse.prevWorldX;
            const dy = this.mouse.targetWorldY - this.mouse.prevWorldY;
            this.mouse.speed = Math.sqrt(dx * dx + dy * dy);

            if (this.mouse.speed > 24) {
              this.emitRipple(this.mouse.targetWorldX, this.mouse.targetWorldY, Math.min(this.mouse.speed * 0.45, 30));
            }
          }
          this.mouse.prevWorldX = this.mouse.targetWorldX;
          this.mouse.prevWorldY = this.mouse.targetWorldY;
        }
      };

      const onPointerEnter = (e) => {
        const rect = this.footer.getBoundingClientRect();
        this.mouse.screenX = e.clientX - rect.left;
        this.mouse.screenY = e.clientY - rect.top;
        this.mouseNdc.x = (this.mouse.screenX / rect.width) * 2 - 1;
        this.mouseNdc.y = -(this.mouse.screenY / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouseNdc, this.camera);
        if (this.raycaster.ray.intersectPlane(this.groundPlane, this.raycastPos)) {
          this.mouse.worldX = this.raycastPos.x;
          this.mouse.worldY = this.raycastPos.y;
          this.mouse.targetWorldX = this.raycastPos.x;
          this.mouse.targetWorldY = this.raycastPos.y;
          this.mouse.targetIntensity = 1.0;
          this.emitRipple(this.mouse.worldX, this.mouse.worldY, 22);
        }
      };

      const onPointerLeave = () => {
        this.mouse.targetIntensity = 0.0;
        this.mouse.prevWorldX = -9999;
        this.mouse.prevWorldY = -9999;
      };

      // Passive listeners on footer container (non-blocking)
      this.footer.addEventListener('pointermove', onPointerMove, { passive: true });
      this.footer.addEventListener('pointerenter', onPointerEnter, { passive: true });
      this.footer.addEventListener('pointerleave', onPointerLeave, { passive: true });

      // Touch interaction
      this.footer.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length > 0) {
          const rect = this.footer.getBoundingClientRect();
          const t = e.touches[0];
          this.mouseNdc.x = ((t.clientX - rect.left) / rect.width) * 2 - 1;
          this.mouseNdc.y = -((t.clientY - rect.top) / rect.height) * 2 + 1;
          this.raycaster.setFromCamera(this.mouseNdc, this.camera);
          if (this.raycaster.ray.intersectPlane(this.groundPlane, this.raycastPos)) {
            this.mouse.worldX = this.raycastPos.x;
            this.mouse.worldY = this.raycastPos.y;
            this.mouse.targetWorldX = this.raycastPos.x;
            this.mouse.targetWorldY = this.raycastPos.y;
            this.mouse.targetIntensity = 1.0;
            this.emitRipple(this.mouse.worldX, this.mouse.worldY, 24);
          }
        }
      }, { passive: true });

      this.footer.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches.length > 0) {
          const rect = this.footer.getBoundingClientRect();
          const t = e.touches[0];
          this.mouseNdc.x = ((t.clientX - rect.left) / rect.width) * 2 - 1;
          this.mouseNdc.y = -((t.clientY - rect.top) / rect.height) * 2 + 1;
          this.raycaster.setFromCamera(this.mouseNdc, this.camera);
          if (this.raycaster.ray.intersectPlane(this.groundPlane, this.raycastPos)) {
            this.mouse.targetWorldX = this.raycastPos.x;
            this.mouse.targetWorldY = this.raycastPos.y;
            this.mouse.targetIntensity = 1.0;
          }
        }
      }, { passive: true });

      this.footer.addEventListener('touchend', () => {
        setTimeout(() => {
          this.mouse.targetIntensity = 0.0;
        }, 1200);
      }, { passive: true });

      // Reduced motion listener
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      mql.addEventListener('change', (e) => {
        this.isReducedMotion = e.matches;
      });
    }

    emitRipple(x, y, strength = 20) {
      if (this.isReducedMotion) return;
      if (this.ripples.length >= MAX_RIPPLES) {
        this.ripples.shift();
      }
      this.ripples.push({
        x: x,
        y: y,
        strength: Math.min(strength, 30),
        time: performance.now(),
        speed: this.options.waveSpeed
      });
    }

    setupObserver() {
      // Pause animation loop when offscreen
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          this.isVisible = entry.isIntersecting;
          if (this.isVisible && !this.rafId) {
            this.lastTime = performance.now();
            this.start();
          }
        });
      }, { rootMargin: '100px 0px 100px 0px' });
      io.observe(this.footer);

      // ResizeObserver
      const ro = new ResizeObserver(() => {
        this.handleResize();
      });
      ro.observe(this.footer);
    }

    handleResize() {
      const rect = this.footer.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);

      if (w === this.width && h === this.height && this.canvas.width > 0) return;
      this.width = Math.max(w, 320);
      this.height = Math.max(h, 300);

      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.renderer.setSize(this.width, this.height, false);

      // Camera distance calculation: gentle oblique perspective
      const fovRad = (36 * Math.PI) / 180;
      const tiltRad = (CAMERA_TILT_DEG * Math.PI) / 180;
      const camDist = (this.height * 0.5) / Math.tan(fovRad * 0.5);

      this.camera.aspect = this.width / this.height;
      this.camera.position.set(0, -camDist * Math.sin(tiltRad), camDist * Math.cos(tiltRad));
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();

      this.rebuildGrid();
    }

    rebuildGrid() {
      const isMobile = this.width < 768;
      const tileSize = isMobile ? this.options.tileSizeMobile : this.options.tileSizeDesktop;
      const tileRadius = isMobile ? this.options.tileRadiusMobile : this.options.tileRadiusDesktop;
      const tileDepth = this.options.tileDepth;
      const bevelSize = this.options.bevelSize;
      const bevelThickness = this.options.bevelThickness;
      const gap = isMobile ? this.options.gapMobile : this.options.gapDesktop;

      this.currentTileSize = tileSize;
      this.currentDepth = tileDepth;
      this.currentBevel = bevelSize;

      // Clean up previous meshes
      if (this.tileMesh) {
        this.scene.remove(this.tileMesh);
        this.tileMesh.geometry.dispose();
        this.tileMesh = null;
      }
      this.iconMeshes.forEach(im => {
        this.scene.remove(im);
        im.geometry.dispose();
      });
      this.iconMeshes = [];
      this.iconInstances = [[], [], [], []];

      // Procedural rounded squircle shape
      const shape = new THREE.Shape();
      const half = tileSize * 0.5;
      const r = tileRadius;
      shape.moveTo(-half + r, -half);
      shape.lineTo(half - r, -half);
      shape.quadraticCurveTo(half, -half, half, -half + r);
      shape.lineTo(half, half - r);
      shape.quadraticCurveTo(half, half, half - r, half);
      shape.lineTo(-half + r, half);
      shape.quadraticCurveTo(-half, half, -half, half - r);
      shape.lineTo(-half, -half + r);
      shape.quadraticCurveTo(-half, -half, -half + r, -half);

      const tileGeo = new THREE.ExtrudeGeometry(shape, {
        depth: tileDepth,
        bevelEnabled: true,
        bevelSegments: 3,
        steps: 1,
        bevelSize: bevelSize,
        bevelThickness: bevelThickness
      });
      tileGeo.center();

      const tileMat = new THREE.MeshStandardMaterial({
        roughness: 0.35,
        metalness: 0.45
      });

      // Diamond Grid Mathematics:
      // Each tile is rotated 45 deg around Z.
      // Pitch between parallel tile edges is physicalSize + gap.
      const physicalSize = tileSize + bevelSize * 2;
      const pitch = physicalSize + gap;
      const invSqrt2 = Math.SQRT1_2; // 0.7071

      this.currentPitch = pitch;

      // Calculate span with generous margin to fill the perspective viewport
      const spanX = this.width * 1.5;
      const spanY = this.height * 1.55;
      const countU = Math.ceil(spanX / (pitch * invSqrt2)) + 4;
      const countV = Math.ceil(spanY / (pitch * invSqrt2)) + 4;

      const minU = -Math.floor(countU / 2);
      const maxU = Math.floor(countU / 2);
      const minV = -Math.floor(countV / 2);
      const maxV = Math.floor(countV / 2);

      this.tiles = [];

      for (let u = minU; u <= maxU; u++) {
        for (let v = minV; v <= maxV; v++) {
          const x = (u - v) * pitch * invSqrt2;
          const y = (u + v) * pitch * invSqrt2;

          if (Math.abs(x) < spanX * 0.58 && Math.abs(y) < spanY * 0.62) {
            // Deterministic icon assignment for ~30% of tiles
            const hash = Math.abs((u * 73856093 ^ v * 19349663) % 100);
            let iconType = -1;
            if (hash < 8) iconType = 0;       // ✦ sparkle
            else if (hash < 16) iconType = 1; // ✳ asterisk
            else if (hash < 24) iconType = 2; // ✴ burst
            else if (hash < 32) iconType = 3; // ✺ spiral

            this.tiles.push({
              u, v,
              baseX: x,
              baseY: y,
              baseZ: 0,
              z: 0,
              vz: 0,
              targetZ: 0,
              tiltX: 0,
              tiltY: 0,
              light: 0,
              iconType: iconType
            });
          }
        }
      }

      const totalCount = this.tiles.length;
      this.tileMesh = new THREE.InstancedMesh(tileGeo, tileMat, totalCount);
      this.scene.add(this.tileMesh);

      // Group icon instances
      this.tiles.forEach((t, idx) => {
        if (t.iconType >= 0) {
          this.iconInstances[t.iconType].push({ tileIdx: idx, tile: t });
        }
      });

      for (let k = 0; k < 4; k++) {
        const im = new THREE.InstancedMesh(this.iconGeo, this.iconMaterials[k], this.iconInstances[k].length);
        this.scene.add(im);
        this.iconMeshes.push(im);
      }

      // Initial transform setup
      const dummy = this.dummy;
      for (let i = 0; i < totalCount; i++) {
        const t = this.tiles[i];
        dummy.position.set(t.baseX, t.baseY, t.baseZ);
        dummy.rotation.set(0, 0, Math.PI * 0.25);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        this.tileMesh.setMatrixAt(i, dummy.matrix);
        this.tileMesh.setColorAt(i, this.colorBase);
      }

      this.tileMesh.instanceMatrix.needsUpdate = true;
      if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;

      const topOffset = (tileDepth + bevelThickness * 2) * 0.5 + 0.35;
      for (let k = 0; k < 4; k++) {
        const list = this.iconInstances[k];
        const im = this.iconMeshes[k];
        for (let j = 0; j < list.length; j++) {
          const t = list[j].tile;
          dummy.position.set(t.baseX, t.baseY, t.baseZ + topOffset);
          dummy.rotation.set(0, 0, Math.PI * 0.25);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          im.setMatrixAt(j, dummy.matrix);
          im.setColorAt(j, this.colorIconBase);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }

    start() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      const loop = (now) => {
        if (!this.isVisible) {
          this.rafId = null;
          return;
        }
        const dt = Math.min((now - this.lastTime) / 1000, 0.05);
        this.lastTime = now;

        this.update(dt, now * 0.001);
        this.render();

        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    }

    update(dt, time) {
      if (!this.tileMesh || !this.tiles.length) return;

      // Lerp mouse world position and intensity
      const lerpSpeed = 10.0 * dt;
      this.mouse.worldX += (this.mouse.targetWorldX - this.mouse.worldX) * lerpSpeed;
      this.mouse.worldY += (this.mouse.targetWorldY - this.mouse.worldY) * lerpSpeed;
      this.mouse.intensity += (this.mouse.targetIntensity - this.mouse.intensity) * (8.0 * dt);

      // Update Cursor Dynamic Point Light (soft pink radiance)
      if (this.cursorPointLight) {
        this.cursorPointLight.position.set(this.mouse.worldX, this.mouse.worldY, 70);
        this.cursorPointLight.intensity = this.mouse.intensity * 3.4;
      }

      // Filter expired shockwave ripples
      const nowMs = performance.now();
      this.ripples = this.ripples.filter(rip => {
        const age = (nowMs - rip.time) / 1000;
        return age < 2.0;
      });

      const mx = this.mouse.worldX;
      const my = this.mouse.worldY;
      const mInt = this.mouse.intensity;
      const hasMouse = mInt > 0.005;
      const isMobile = this.width < 768;
      const radius = isMobile ? this.options.waveRadiusMobile : this.options.waveRadiusDesktop;
      const radiusSq = radius * radius;
      const peakLift = this.options.peakLift;
      const ambAmp = this.isReducedMotion ? 0 : this.options.ambientAmplitude;
      const ambSpeed = this.options.ambientSpeed;

      const totalCount = this.tiles.length;
      for (let i = 0; i < totalCount; i++) {
        const t = this.tiles[i];

        // 1) Idle ambient harmonic wave
        let targetZ = 0;
        if (!this.isReducedMotion) {
          const w1 = Math.sin(t.baseX * 0.004 + t.baseY * 0.003 + time * ambSpeed) * ambAmp;
          const w2 = Math.cos(t.baseX * 0.0025 - t.baseY * 0.0035 + time * (ambSpeed * 0.8)) * (ambAmp * 0.55);
          targetZ = w1 + w2;
        }

        // 2) Cursor Gaussian proximity lift
        let lightVal = 0;
        if (hasMouse) {
          const dx = t.baseX - mx;
          const dy = t.baseY - my;
          const distSq = dx * dx + dy * dy;

          if (distSq < radiusSq) {
            const dist = Math.sqrt(distSq);
            const norm = 1.0 - (dist / radius);
            const bell = Math.cos((dist / radius) * Math.PI * 0.5);
            targetZ += Math.pow(bell, 1.8) * peakLift * mInt;
            lightVal = Math.pow(norm, 1.3) * mInt;
          }
        }

        // 3) Dynamic shockwave ripples
        const ripLen = this.ripples.length;
        for (let j = 0; j < ripLen; j++) {
          const rip = this.ripples[j];
          const age = (nowMs - rip.time) / 1000;
          const curRadius = age * rip.speed;
          const dx = t.baseX - rip.x;
          const dy = t.baseY - rip.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const diff = Math.abs(dist - curRadius);
          const ringWidth = 80.0;

          if (diff < ringWidth * 1.5) {
            const decay = Math.exp(-age * 2.0);
            const ringShape = Math.cos((diff / ringWidth) * Math.PI * 0.5);
            if (ringShape > 0) {
              const pulse = ringShape * rip.strength * decay;
              targetZ += pulse;
              lightVal = Math.max(lightVal, (pulse / 30.0) * 0.9);
            }
          }
        }

        t.targetZ = targetZ;
        t.light = lightVal;

        // Damped harmonic spring oscillator
        if (!this.isReducedMotion) {
          const force = SPRING_K * (t.targetZ - t.z) - SPRING_DAMP * t.vz;
          t.vz += force * dt;
          t.z += t.vz * dt;
        } else {
          t.z = t.targetZ;
        }
      }

      // Calculate spatial tilts and update Three.js matrices & colors
      const dummy = this.dummy;
      const tileMesh = this.tileMesh;
      const topOffset = (this.currentDepth + this.currentBevel * 2) * 0.5 + 0.35;

      for (let i = 0; i < totalCount; i++) {
        const t = this.tiles[i];

        // Gentle dynamic tilt based on proximity
        if (hasMouse && t.light > 0.05) {
          const dx = t.baseX - mx;
          const dy = t.baseY - my;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
          t.tiltX = (-dy / d) * (t.light * 0.16);
          t.tiltY = (dx / d) * (t.light * 0.16);
        } else {
          t.tiltX *= 0.85;
          t.tiltY *= 0.85;
        }

        dummy.position.set(t.baseX, t.baseY, t.baseZ + t.z);
        dummy.rotation.set(t.tiltX, t.tiltY, Math.PI * 0.25);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        tileMesh.setMatrixAt(i, dummy.matrix);

        // Exact Reference Palette Shading:
        // Peak: Radiant White & Pale Pink -> Mid: Vibrant Magenta & Pink with subtle cyan glint -> Fringe: Mauve/Violet -> Base: Charcoal Obsidian
        const lv = t.light;
        if (lv > 0.01) {
          if (lv > 0.72) {
            // Peak center: radiant white to soft pale pink
            const f = (lv - 0.72) / 0.28;
            this.tempColor.copy(this.colorPalePink).lerp(this.colorWhite, f);
          } else if (lv > 0.38) {
            // Mid glow: vibrant pink/magenta with subtle cyan/violet iridescent blend
            const f = (lv - 0.38) / 0.34;
            this.tempColor.copy(this.colorMagenta).lerp(this.colorPink, f);
            if (f < 0.4) {
              this.tempColor.lerp(this.colorCyan, (0.4 - f) * 0.35);
            }
          } else {
            // Outer fringe: deep mauve/violet transitioning to dark obsidian
            const f = lv / 0.38;
            this.tempColor.copy(this.colorBase).lerp(this.colorMauve, Math.pow(f, 1.2));
          }
        } else {
          this.tempColor.copy(this.colorBase);
        }

        tileMesh.setColorAt(i, this.tempColor);
      }

      tileMesh.instanceMatrix.needsUpdate = true;
      if (tileMesh.instanceColor) tileMesh.instanceColor.needsUpdate = true;

      // Update Icon Meshes
      for (let k = 0; k < 4; k++) {
        const list = this.iconInstances[k];
        const im = this.iconMeshes[k];
        for (let j = 0; j < list.length; j++) {
          const t = list[j].tile;
          dummy.position.set(t.baseX, t.baseY, t.baseZ + t.z + topOffset);
          dummy.rotation.set(t.tiltX, t.tiltY, Math.PI * 0.25);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          im.setMatrixAt(j, dummy.matrix);

          if (t.light > 0.05) {
            this.tempIconColor.copy(this.colorIconBase).lerp(this.colorIconLit, Math.min(1.0, t.light * 1.5));
          } else {
            this.tempIconColor.copy(this.colorIconBase);
          }
          im.setColorAt(j, this.tempIconColor);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }

    render() {
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    }

    destroy() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.tileMesh) {
        this.scene.remove(this.tileMesh);
        this.tileMesh.geometry.dispose();
      }
      this.iconMeshes.forEach(im => {
        this.scene.remove(im);
        im.geometry.dispose();
      });
      if (this.renderer) {
        this.renderer.dispose();
      }
      this.tiles = [];
      this.ripples = [];
    }
  }

  // Global exposure
  window.InteractiveBoxGrid = InteractiveBoxGrid;

  function autoInitFooterGrid() {
    const footer = document.getElementById('site-footer');
    if (footer && !footer.__boxGrid) {
      footer.__boxGrid = new InteractiveBoxGrid(footer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInitFooterGrid);
  } else {
    autoInitFooterGrid();
  }
})();
