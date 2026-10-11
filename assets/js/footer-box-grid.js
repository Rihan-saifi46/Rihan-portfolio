/**
 * Lumora Portfolio — Interactive 3D Box Grid Engine
 * Powered by Three.js InstancedMesh
 * Inspired by Framer Marketplace "Interactive Box Grid"
 * 
 * Features:
 * - Visible, dense grid of individual 3D boxes with physical depth, top faces, and edge wireframes
 * - Oblique perspective camera displaying 3D top and front extrusion faces at rest
 * - Damped harmonic spring physics (wave ripple + Gaussian cursor lift + kinetic impulses)
 * - Dynamic cursor point light casting warm amber/gold reflections on nearby boxes
 * - Idle ambient breathing wave keeping the grid living on desktop & mobile
 * - Lightweight & highly performant: 1 draw call for all solid boxes + 1 for edge highlights
 * - IntersectionObserver auto-pause, ResizeObserver, reduced-motion compliance
 * - Non-blocking pointer events preserving all footer links and text selection
 */

(function () {
  'use strict';

  // Physics constants
  const SPRING_K = 135.0;
  const SPRING_DAMP = 13.5;
  const MAX_RIPPLES = 8;
  const CAMERA_TILT_DEG = 36; // Oblique downward camera pitch

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
        boxWidth: 44,
        boxHeight: 44,
        boxDepth: 16,
        boxGap: 9,
        peakLift: 34,
        waveRadius: 170,
        waveSpeed: 330,
        ambientAmplitude: 3.5,
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

      this.init();
    }

    init() {
      if (typeof THREE === 'undefined') {
        console.warn('Three.js not loaded, interactive 3D box grid unavailable.');
        return;
      }

      this.setupThree();
      this.setupEvents();
      this.handleResize();
      this.setupObserver();
      this.start();
    }

    setupThree() {
      // Scene
      this.scene = new THREE.Scene();

      // Camera: Perspective with oblique pitch
      this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);

      // WebGL Renderer
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance'
      });
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setClearColor(0x000000, 0);

      // Lighting Setup
      // 1) Ambient Light: Ensures resting boxes have rich metallic slate presence
      this.ambientLight = new THREE.AmbientLight(0x40495a, 2.2);
      this.scene.add(this.ambientLight);

      // 2) Directional Key Light: Angled from top-front-right for dimensional shading
      this.dirLight = new THREE.DirectionalLight(0xffffff, 2.4);
      this.dirLight.position.set(300, -500, 700);
      this.scene.add(this.dirLight);

      // 3) Cursor Dynamic Point Light: Warm Amber / Gold that tracks the pointer
      this.cursorPointLight = new THREE.PointLight(0xe88d43, 0, 420);
      this.cursorPointLight.position.set(0, 0, 50);
      this.scene.add(this.cursorPointLight);

      // 4) Cool Titanium Rim Light: Subtle opposing accent
      this.rimLight = new THREE.PointLight(0x7dd3fc, 0.9, 650);
      this.rimLight.position.set(-400, 300, 150);
      this.scene.add(this.rimLight);

      // Raycaster & Ground Plane (Z = 0)
      this.raycaster = new THREE.Raycaster();
      this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      this.mouseNdc = new THREE.Vector2(-9999, -9999);
      this.raycastPos = new THREE.Vector3();

      // Dummy for matrix calculations
      this.dummy = new THREE.Object3D();

      // Palette Colors
      this.colorBaseBox = new THREE.Color(0x1e2330); // Sleek metallic obsidian slate
      this.colorBaseEdge = new THREE.Color(0x4b5568); // Luminous metallic edge line
      this.colorAmber = new THREE.Color(0xc76f36);    // Lumora brand warm amber
      this.colorGold = new THREE.Color(0xf5a623);     // Wave crest warm gold
      this.colorWhiteGleam = new THREE.Color(0xfef08a);// Specular rim gleam
      this.tempColor = new THREE.Color();
      this.tempEdgeColor = new THREE.Color();
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

            if (this.mouse.speed > 22) {
              this.emitRipple(this.mouse.targetWorldX, this.mouse.targetWorldY, Math.min(this.mouse.speed * 0.45, 32));
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
          this.emitRipple(this.mouse.worldX, this.mouse.worldY, 24);
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
            this.emitRipple(this.mouse.worldX, this.mouse.worldY, 26);
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

      // Prefers-reduced-motion listener
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      mql.addEventListener('change', (e) => {
        this.isReducedMotion = e.matches;
      });
    }

    emitRipple(x, y, strength = 22) {
      if (this.isReducedMotion) return;
      if (this.ripples.length >= MAX_RIPPLES) {
        this.ripples.shift();
      }
      this.ripples.push({
        x: x,
        y: y,
        strength: Math.min(strength, 36),
        time: performance.now(),
        speed: this.options.waveSpeed
      });
    }

    setupObserver() {
      // Pause animation loop when footer is offscreen (saves 100% GPU/CPU)
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

      // Camera distance calculation: 1 world unit corresponds to ~1 pixel at scene center
      const fovRad = (40 * Math.PI) / 180;
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
      const boxW = isMobile ? 34 : this.options.boxWidth;
      const boxH = isMobile ? 34 : this.options.boxHeight;
      const boxD = isMobile ? 12 : this.options.boxDepth;
      const gap = isMobile ? 7 : this.options.boxGap;
      const pitch = boxW + gap;

      this.currentBoxW = boxW;
      this.currentBoxH = boxH;
      this.currentBoxD = boxD;
      this.currentPitch = pitch;

      // Calculate visible span with generous overscan to fill the perspective frustum
      const spanX = this.width * 1.35;
      const spanY = this.height * 1.45;

      this.cols = Math.ceil(spanX / pitch) + 2;
      this.rows = Math.ceil(spanY / pitch) + 2;

      const totalCount = this.cols * this.rows;

      // Dispose previous meshes
      if (this.boxMesh) {
        this.scene.remove(this.boxMesh);
        this.boxMesh.geometry.dispose();
        this.boxMesh = null;
      }
      if (this.edgeMesh) {
        this.scene.remove(this.edgeMesh);
        this.edgeMesh.geometry.dispose();
        this.edgeMesh = null;
      }

      // Geometries
      const boxGeo = new THREE.BoxGeometry(boxW, boxH, boxD);
      const edgeGeo = new THREE.EdgesGeometry(boxGeo);

      // Materials
      const boxMat = new THREE.MeshStandardMaterial({
        roughness: 0.38,
        metalness: 0.65
      });

      const edgeMat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 0.55
      });

      this.boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, totalCount);
      this.edgeMesh = new THREE.InstancedMesh(edgeGeo, edgeMat, totalCount);

      this.scene.add(this.boxMesh);
      this.scene.add(this.edgeMesh);

      const startX = -((this.cols - 1) * pitch) * 0.5;
      const startY = -((this.rows - 1) * pitch) * 0.5;

      this.tiles = [];
      const dummy = this.dummy;

      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const idx = r * this.cols + c;
          const x = startX + c * pitch;
          const y = startY + r * pitch;

          this.tiles.push({
            c, r,
            baseX: x,
            baseY: y,
            baseZ: boxD * 0.5,
            z: 0,
            vz: 0,
            targetZ: 0,
            tiltX: 0,
            tiltY: 0,
            light: 0
          });

          dummy.position.set(x, y, boxD * 0.5);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();

          this.boxMesh.setMatrixAt(idx, dummy.matrix);
          this.edgeMesh.setMatrixAt(idx, dummy.matrix);

          this.boxMesh.setColorAt(idx, this.colorBaseBox);
          this.edgeMesh.setColorAt(idx, this.colorBaseEdge);
        }
      }

      this.boxMesh.instanceMatrix.needsUpdate = true;
      this.edgeMesh.instanceMatrix.needsUpdate = true;
      if (this.boxMesh.instanceColor) this.boxMesh.instanceColor.needsUpdate = true;
      if (this.edgeMesh.instanceColor) this.edgeMesh.instanceColor.needsUpdate = true;
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
      if (!this.boxMesh || !this.tiles.length) return;

      // Lerp mouse world position and intensity
      const lerpSpeed = 10.0 * dt;
      this.mouse.worldX += (this.mouse.targetWorldX - this.mouse.worldX) * lerpSpeed;
      this.mouse.worldY += (this.mouse.targetWorldY - this.mouse.worldY) * lerpSpeed;
      this.mouse.intensity += (this.mouse.targetIntensity - this.mouse.intensity) * (8.0 * dt);

      // Update Cursor Dynamic Point Light
      if (this.cursorPointLight) {
        this.cursorPointLight.position.set(this.mouse.worldX, this.mouse.worldY, 55);
        this.cursorPointLight.intensity = this.mouse.intensity * 3.6;
      }

      // Filter expired ripples
      const nowMs = performance.now();
      this.ripples = this.ripples.filter(rip => {
        const age = (nowMs - rip.time) / 1000;
        return age < 2.2;
      });

      const mx = this.mouse.worldX;
      const my = this.mouse.worldY;
      const mInt = this.mouse.intensity;
      const hasMouse = mInt > 0.005;
      const radius = this.options.waveRadius;
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
          const w1 = Math.sin(t.baseX * 0.0035 + t.baseY * 0.0025 + time * ambSpeed) * ambAmp;
          const w2 = Math.cos(t.baseX * 0.0022 - t.baseY * 0.003 + time * (ambSpeed * 0.8)) * (ambAmp * 0.6);
          targetZ = w1 + w2;
        }

        // 2) Cursor Gaussian proximity lift
        let lightVal = 0;
        if (hasMouse) {
          const dx = t.baseX - mx;
          const dy = t.baseY - my;
          const distSq = dx * dx + dy * dy;

          if (distSq < radiusSq * 2.8) {
            const bell = Math.exp(-distSq / (2 * radiusSq));
            targetZ += bell * peakLift * mInt;
            lightVal = Math.max(0, 1.0 - Math.sqrt(distSq) / (radius * 1.5)) * mInt;
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
          const ringWidth = 75.0;

          if (diff < ringWidth * 1.5) {
            const decay = Math.exp(-age * 1.8);
            const ringShape = Math.cos((diff / ringWidth) * Math.PI * 0.5);
            if (ringShape > 0) {
              const pulse = ringShape * rip.strength * decay;
              targetZ += pulse;
              lightVal = Math.max(lightVal, (pulse / 35.0) * 0.85);
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
      const pitch = this.currentPitch;
      const dummy = this.dummy;
      const boxMesh = this.boxMesh;
      const edgeMesh = this.edgeMesh;

      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const idx = r * this.cols + c;
          const t = this.tiles[idx];

          const upIdx = Math.max(0, r - 1) * this.cols + c;
          const downIdx = Math.min(this.rows - 1, r + 1) * this.cols + c;
          const leftIdx = r * this.cols + Math.max(0, c - 1);
          const rightIdx = r * this.cols + Math.min(this.cols - 1, c + 1);

          const dzY = (this.tiles[downIdx].z - this.tiles[upIdx].z) / (pitch * 2);
          const dzX = (this.tiles[rightIdx].z - this.tiles[leftIdx].z) / (pitch * 2);

          t.tiltX = Math.max(-0.28, Math.min(0.28, -dzY * 0.35));
          t.tiltY = Math.max(-0.28, Math.min(0.28, dzX * 0.35));

          // Set 3D transform
          dummy.position.set(t.baseX, t.baseY, t.baseZ + t.z);
          dummy.rotation.set(t.tiltX, t.tiltY, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();

          boxMesh.setMatrixAt(idx, dummy.matrix);
          edgeMesh.setMatrixAt(idx, dummy.matrix);

          // Dynamic Color Shading:
          // Base obsidian slate -> warm amber -> golden crest
          const liftNorm = Math.max(0, Math.min(1.0, t.z / 28.0));
          const highlight = Math.max(0, Math.min(1.0, t.light * 1.2 + liftNorm * 0.5));

          if (highlight > 0.02) {
            // Blend from base slate to warm amber, then to luminous gold
            if (highlight < 0.6) {
              this.tempColor.copy(this.colorBaseBox).lerp(this.colorAmber, highlight / 0.6);
              this.tempEdgeColor.copy(this.colorBaseEdge).lerp(this.colorAmber, highlight / 0.6);
            } else {
              this.tempColor.copy(this.colorAmber).lerp(this.colorGold, (highlight - 0.6) / 0.4);
              this.tempEdgeColor.copy(this.colorAmber).lerp(this.colorWhiteGleam, (highlight - 0.6) / 0.4);
            }
          } else {
            this.tempColor.copy(this.colorBaseBox);
            this.tempEdgeColor.copy(this.colorBaseEdge);
          }

          boxMesh.setColorAt(idx, this.tempColor);
          edgeMesh.setColorAt(idx, this.tempEdgeColor);
        }
      }

      boxMesh.instanceMatrix.needsUpdate = true;
      edgeMesh.instanceMatrix.needsUpdate = true;
      if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
      if (edgeMesh.instanceColor) edgeMesh.instanceColor.needsUpdate = true;
    }

    render() {
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    }

    destroy() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.boxMesh) {
        this.scene.remove(this.boxMesh);
        this.boxMesh.geometry.dispose();
      }
      if (this.edgeMesh) {
        this.scene.remove(this.edgeMesh);
        this.edgeMesh.geometry.dispose();
      }
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
