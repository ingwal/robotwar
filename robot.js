// Cute battle robot renderer for WebGL2. No dependencies.
//
// Usage:
//   const gfx = RobotGfx.create(gl);
//   gfx.begin(viewProj, eye);          // once per frame
//   gfx.drawArena(halfSize);
//   gfx.drawRobot(robot, time);        // see ROBOT STATE below
//   gfx.drawBullet(bullet);
//   gfx.drawExplosion({ x, z, age, color, seed });  // done when age >= RobotGfx.EXPLOSION_TIME
//   gfx.drawWalls([{ x0, z0, x1, z1 }, ...]);      // interior walls, axis-aligned boxes
//   gfx.drawRadar(robot);                          // the robot's last radar scan, if any (robot.scan)
//   gfx.drawImpact({ x, y, z, age });               // bullet hitting a wall; done after IMPACT_TIME
//
// ROBOT STATE (all optional except x, z, heading, turret, color):
//   x, z       position on the ground plane
//   heading    body direction in radians (0 = +z, PI/2 = +x)
//   turret     head/cannon direction in radians, world space (independent of body)
//   color      [r, g, b] team color, 0..1
//   speed      current forward speed (drives bobbing and antenna sway)
//   wheel      distance travelled (drives wheel spin)
//   turnRate   body turn speed in rad/s (antenna sways on turns)
//   recoil     [left, right] 0..1, set to 1 when a cannon fires and let it decay
//   hit        0..1 white flash, set to 1 when hit and let it decay
//   scan       last radar scan { angle, width, range, found, age } — drawn as a beam by drawRadar
//   hp, maxHp  life left / starting life; when hp is set a sign shows it (default maxHp 10)
//   dying      null normally; count 0..1 when hp hits 0 to flash and shudder before exploding
//   seed       any number, de-syncs idle animations between robots
//   scale      overall size (default 1, robot is about 1.7 units tall)
(function (global) {
  'use strict';

  // ---------- tiny mat4 (column-major, like OpenGL) ----------
  const mat4 = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
          o[c * 4 + r] = s;
        }
      return o;
    },
    chain: (...ms) => ms.reduce((acc, m) => mat4.mul(acc, m)),
    translate(x, y, z) { const m = mat4.identity(); m[12] = x; m[13] = y; m[14] = z; return m; },
    scale(x, y = x, z = x) { const m = mat4.identity(); m[0] = x; m[5] = y; m[10] = z; return m; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    ortho(halfW, halfH, near, far) {
      const nf = 1 / (near - far);
      return new Float32Array([1 / halfW, 0, 0, 0, 0, 1 / halfH, 0, 0, 0, 0, 2 * nf, 0, 0, 0, (far + near) * nf, 1]);
    },
    lookAt(eye, at, up) {
      const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const z = norm(eye.map((c, i) => c - at[i]));
      const x = norm(cross(up, z));
      const y = cross(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
    },
  };
  const { chain, translate, scale, rotX, rotY, rotZ } = mat4;

  // ---------- meshes: interleaved [px py pz nx ny nz] ----------

  // Box with rounded edges, baked at its final size so the rounding stays round.
  function roundedBox(sx, sy, sz, r, S = 4) {
    const half = [sx / 2, sy / 2, sz / 2];
    const samples = half.map((h) => {
      const a = [];
      for (let k = 0; k <= S; k++) a.push(-(h - r) - r * Math.cos((k / S) * Math.PI / 2));
      for (let k = 0; k <= S; k++) a.push(h - r + r * Math.sin((k / S) * Math.PI / 2));
      return a;
    });
    const data = [], idx = [];
    for (let a = 0; a < 3; a++)
      for (const sgn of [-1, 1]) {
        const u = (a + 1) % 3, v = (a + 2) % 3;
        const su = samples[u], sv = samples[v], n = su.length, start = data.length / 6;
        for (let j = 0; j < sv.length; j++)
          for (let i = 0; i < n; i++) {
            const p = [0, 0, 0];
            p[a] = sgn * half[a]; p[u] = su[i]; p[v] = sv[j];
            const inner = p.map((c, k) => Math.max(-(half[k] - r), Math.min(half[k] - r, c)));
            const d = p.map((c, k) => c - inner[k]);
            const len = Math.hypot(...d);
            const nrm = d.map((c) => c / len);
            data.push(inner[0] + nrm[0] * r, inner[1] + nrm[1] * r, inner[2] + nrm[2] * r, ...nrm);
          }
        for (let j = 0; j < sv.length - 1; j++)
          for (let i = 0; i < n - 1; i++) {
            const q = start + j * n + i;
            if (sgn > 0) idx.push(q, q + 1, q + n + 1, q, q + n + 1, q + n);
            else idx.push(q, q + n + 1, q + 1, q, q + n, q + n + 1);
          }
      }
    return { data, idx };
  }

  // Unit sphere, radius 1.
  function sphere(seg = 24, rings = 16) {
    const data = [], idx = [];
    for (let j = 0; j <= rings; j++) {
      const th = (j / rings) * Math.PI;
      for (let i = 0; i <= seg; i++) {
        const ph = (i / seg) * Math.PI * 2;
        const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
        data.push(x, y, z, x, y, z);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < seg; i++) {
        const q = j * (seg + 1) + i;
        idx.push(q, q + seg + 1, q + 1, q + 1, q + seg + 1, q + seg + 2);
      }
    return { data, idx };
  }

  // Cylinder along Y, radius 1, from y=-0.5 to y=0.5, with caps.
  function cylinder(seg = 24) {
    const data = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      data.push(c, -0.5, s, c, 0, s, c, 0.5, s, c, 0, s);
      if (i < seg) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    for (const y of [-0.5, 0.5]) {
      const center = data.length / 6, ny = Math.sign(y);
      data.push(0, y, 0, 0, ny, 0);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        data.push(Math.cos(a), y, Math.sin(a), 0, ny, 0);
        if (i < seg) idx.push(center, center + 1 + i, center + 2 + i);
      }
    }
    return { data, idx };
  }

  // Flat disc at y=0, radius 1 (used for blob shadows).
  function disc(seg = 32) {
    const data = [0, 0, 0, 0, 1, 0], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      data.push(Math.cos(a), 0, Math.sin(a), 0, 1, 0);
      if (i < seg) idx.push(0, 1 + i, 2 + i);
    }
    return { data, idx };
  }

  // ---------- shaders ----------
  const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
uniform mat4 uViewProj, uModel;
out vec3 vNor, vWorld, vLocal;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vLocal = aPos;
  vNor = transpose(inverse(mat3(uModel))) * aNor;
  gl_Position = uViewProj * w;
}`;

  // uMode: 0 = lit part, 1 = soft blob shadow, 2 = checkered floor
  const FS = `#version 300 es
precision highp float;
in vec3 vNor, vWorld, vLocal;
uniform vec3 uColor, uEye;
uniform float uEmissive, uFlash, uAlpha;
uniform int uMode;
out vec4 outColor;
void main() {
  if (uMode == 3) {
    // translucent glow (radar beam / ping) that fades away from the origin
    float a = uAlpha * (1.0 - 0.7 * smoothstep(0.0, 1.0, length(vLocal.xz)));
    outColor = vec4(uColor, a);
    return;
  }
  if (uMode == 1) {
    float a = uAlpha * (1.0 - smoothstep(0.35, 1.0, length(vLocal.xz)));
    outColor = vec4(0.08, 0.1, 0.18, a);
    return;
  }
  vec3 N = normalize(vNor);
  vec3 V = normalize(uEye - vWorld);
  vec3 L = normalize(vec3(-0.5, 1.0, 0.4));
  vec3 base = uColor;
  float shiny = 1.0;
  if (uMode == 2) {
    vec2 cell = floor(vWorld.xz);
    base *= mix(1.0, 0.92, mod(cell.x + cell.y, 2.0));
    shiny = 0.0;
  }
  // soft two-tone diffuse gives a friendly toy look
  float diff = smoothstep(-0.15, 0.55, dot(N, L));
  vec3 sky = vec3(0.78, 0.86, 1.0), ground = vec3(0.5, 0.45, 0.42);
  vec3 amb = mix(ground, sky, N.y * 0.5 + 0.5) * 0.5;
  float spec = pow(max(dot(N, normalize(L + V)), 0.0), 48.0) * 0.4 * shiny;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.3 * shiny;
  vec3 col = base * (amb + vec3(1.0, 0.96, 0.9) * diff * 0.7) + spec + rim * sky;
  col = mix(col, uColor * 1.15 + 0.1, uEmissive);
  col = mix(col, vec3(1.0), uFlash);
  outColor = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function upload(gl, { data, idx }) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }

  // ---------- palette ----------
  const lighten = (c, t) => c.map((v) => v + (1 - v) * t);
  const TREAD = [0.22, 0.24, 0.3];
  const METAL = [0.72, 0.75, 0.8];
  const BARREL = [0.3, 0.32, 0.38];
  const SCREEN = [0.07, 0.09, 0.15];
  const EYE = [0.55, 0.95, 1.0];
  const CHEEK = [1.0, 0.5, 0.62];
  const BULB = [1.0, 0.85, 0.35];
  const FLASH = [1.0, 0.85, 0.4];
  const FLOOR = [0.88, 0.86, 0.82];
  const WALL = [0.55, 0.6, 0.72];
  const SEG_OFF = [0.14, 0.17, 0.25];
  const HEART = [1.0, 0.3, 0.4];
  const FIRE = [1.0, 0.5, 0.2];
  const BULLET = [0.05, 0.05, 0.07];
  const INNER_WALL = [0.5, 0.56, 0.7];
  const WALL_HEIGHT = 1.5;
  const RADAR_FADE = 0.3;
  const IMPACT_TIME = 0.2;

  // green -> yellow -> red as health drops
  function healthColor(f) {
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const red = [1, 0.3, 0.3], yellow = [1, 0.9, 0.3], green = [0.4, 1, 0.5];
    return f > 0.5 ? mix(yellow, green, (f - 0.5) * 2) : mix(red, yellow, Math.max(0, f) * 2);
  }

  // seven-segment layout: which of segments a..g are lit for each digit
  const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  const SEG_W = 0.11, SEG_H = 0.2, SEG_T = 0.026;
  const SEGMENTS = {
    a: [0, SEG_H / 2, SEG_W, SEG_T], d: [0, -SEG_H / 2, SEG_W, SEG_T], g: [0, 0, SEG_W, SEG_T],
    b: [SEG_W / 2, SEG_H / 4, SEG_T, SEG_H / 2], c: [SEG_W / 2, -SEG_H / 4, SEG_T, SEG_H / 2],
    e: [-SEG_W / 2, -SEG_H / 4, SEG_T, SEG_H / 2], f: [-SEG_W / 2, SEG_H / 4, SEG_T, SEG_H / 2],
  };

  const EXPLOSION_TIME = 1.3;

  function create(gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    for (const n of ['uViewProj', 'uModel', 'uColor', 'uEye', 'uEmissive', 'uFlash', 'uAlpha', 'uMode'])
      u[n] = gl.getUniformLocation(prog, n);

    const M = {
      cube: upload(gl, roundedBox(1, 1, 1, 0.08, 2)),
      slab: upload(gl, roundedBox(1, 1, 1, 0.002, 1)),
      sphere: upload(gl, sphere()),
      cyl: upload(gl, cylinder()),
      disc: upload(gl, disc()),
      // radar wedge: apex at the origin, flat front edge at z=1 from x=-1 to x=1
      fan: upload(gl, { data: [0, 0, 0, 0, 1, 0, -1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], idx: [0, 1, 2] }),
      tread: upload(gl, roundedBox(0.3, 0.46, 1.2, 0.14)),
      body: upload(gl, roundedBox(0.9, 0.62, 0.85, 0.2)),
      plate: upload(gl, roundedBox(0.5, 0.28, 0.06, 0.03, 2)),
      head: upload(gl, roundedBox(1.0, 0.62, 0.8, 0.22)),
      screen: upload(gl, roundedBox(0.76, 0.4, 0.08, 0.035, 3)),
      signFrame: upload(gl, roundedBox(0.66, 0.36, 0.06, 0.03, 2)),
      signScreen: upload(gl, roundedBox(0.58, 0.28, 0.02, 0.009, 2)),
    };

    let flash = 0;
    let eyePos = [0, 10, 10];

    function draw(mesh, model, color, emissive = 0, mode = 0) {
      gl.uniformMatrix4fv(u.uModel, false, model);
      gl.uniform3fv(u.uColor, color);
      gl.uniform1f(u.uEmissive, emissive);
      gl.uniform1f(u.uFlash, flash);
      gl.uniform1i(u.uMode, mode);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }

    function drawGlow(mesh, model, color, alpha) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(u.uAlpha, alpha);
      draw(mesh, model, color, 0, 3);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    function drawShadow(x, z, radius, alpha = 0.45) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(u.uAlpha, alpha);
      draw(M.disc, chain(translate(x, 0.01, z), scale(radius, 1, radius)), [0, 0, 0], 0, 1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    function begin(viewProj, eye) {
      gl.useProgram(prog);
      gl.enable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
      gl.uniform3fv(u.uEye, eye);
      eyePos = eye;
      flash = 0;
    }

    function drawArena(half) {
      flash = 0;
      draw(M.slab, chain(translate(0, -0.1, 0), scale(half * 2, 0.2, half * 2)), FLOOR, 0, 2);
      const t = 0.3, h = 0.35, len = half * 2 + t;
      for (const s of [-1, 1]) {
        draw(M.slab, chain(translate(s * (half + t / 2), h / 2, 0), scale(t, h, len)), WALL);
        draw(M.slab, chain(translate(0, h / 2, s * (half + t / 2)), scale(len, h, t)), WALL);
      }
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const px = sx * (half + t / 2), pz = sz * (half + t / 2);
          draw(M.cyl, chain(translate(px, 0.3, pz), scale(0.28, 0.6, 0.28)), lighten(WALL, 0.3));
          draw(M.sphere, chain(translate(px, 0.64, pz), scale(0.16)), BULB, 0.8);
        }
    }

    function drawRobot(r, time) {
      const dying = r.dying ?? null;
      const s = (r.scale ?? 1) * (1 + (dying ?? 0) * 0.15);
      const seed = r.seed ?? 0;
      const col = r.color;
      const moving = Math.min(1, Math.abs(r.speed ?? 0));
      const wheel = r.wheel ?? 0;
      const [recL, recR] = r.recoil ?? [0, 0];
      const recoil = Math.max(recL, recR);

      drawShadow(r.x, r.z, 0.95 * s);
      flash = (r.hit ?? 0) * 0.85;
      if (dying !== null && Math.sin(time * 30) > 0) flash = Math.max(flash, 0.6);

      // shudder harder and harder while dying
      const shake = dying !== null ? Math.sin(time * 60) * 0.06 * (0.3 + dying) : 0;
      const bob = Math.abs(Math.sin(wheel * 5)) * 0.04 * moving + Math.sin(time * 2.2 + seed) * 0.012;
      const base = chain(translate(r.x + shake, 0, r.z), rotY(r.heading), scale(s));

      // treads with spinning hub caps
      const spin = wheel / 0.23;
      for (const side of [-1, 1]) {
        draw(M.tread, chain(base, translate(side * 0.48, 0.25, 0)), TREAD);
        for (const wz of [-0.38, 0.38]) {
          const hub = chain(base, translate(side * 0.64, 0.25, wz));
          draw(M.cyl, chain(hub, rotZ(Math.PI / 2), scale(0.15, 0.05, 0.15)), METAL);
          draw(M.cube, chain(hub, translate(side * 0.03, 0, 0), rotX(spin), scale(0.04, 0.24, 0.06)), lighten(col, 0.2));
        }
      }

      // body
      const body = chain(base, translate(0, 0.74 + bob, 0));
      draw(M.body, body, col);
      draw(M.plate, chain(body, translate(0, -0.02, 0.43)), lighten(col, 0.55));
      draw(M.sphere, chain(body, translate(0, 0, 0.47), scale(0.06)), [1, 0.35, 0.4], 0.6 + 0.4 * Math.sin(time * 4 + seed));
      for (const side of [-1, 1])
        draw(M.cyl, chain(body, translate(side * 0.22, 0.26, -0.36), scale(0.06, 0.28, 0.06)), METAL);
      draw(M.cyl, chain(base, translate(0, 1.1 + bob, 0), scale(0.13, 0.18, 0.13)), METAL);

      // head = turret, aims independently of the body and kicks back on recoil
      const head = chain(base, translate(0, 1.42 + bob, 0), rotY(r.turret - r.heading), rotX(-recoil * 0.12));
      draw(M.head, head, col);
      draw(M.screen, chain(head, translate(0, 0, 0.37)), SCREEN);

      const blinking = (time + seed * 1.7) % 3.8 < 0.14;
      for (const side of [-1, 1]) {
        draw(M.sphere, chain(head, translate(side * 0.16, 0.03, 0.415), scale(0.085, blinking ? 0.015 : 0.11, 0.03)), EYE, 1);
        if (!blinking) draw(M.sphere, chain(head, translate(side * 0.16 + 0.03, 0.08, 0.44), scale(0.025)), [1, 1, 1], 1);
        draw(M.sphere, chain(head, translate(side * 0.28, -0.1, 0.41), scale(0.055, 0.03, 0.02)), CHEEK, 0.6);
      }
      // mouth: a flat smile, an "o" while shooting
      if (recoil > 0.3) draw(M.sphere, chain(head, translate(0, -0.11, 0.415), scale(0.04, 0.04, 0.02)), EYE, 1);
      else draw(M.cube, chain(head, translate(0, -0.11, 0.415), scale(0.1, 0.022, 0.02)), EYE, 1);

      // ear cannons
      [recL, recR].forEach((rec, i) => {
        const side = i === 0 ? -1 : 1, kick = rec * 0.12;
        draw(M.cyl, chain(head, translate(side * 0.5, 0, 0), rotZ(Math.PI / 2), scale(0.17, 0.12, 0.17)), METAL);
        draw(M.cyl, chain(head, translate(side * 0.6, -0.02, 0.22 - kick), rotX(Math.PI / 2), scale(0.065, 0.5, 0.065)), BARREL);
        draw(M.cyl, chain(head, translate(side * 0.6, -0.02, 0.47 - kick), rotX(Math.PI / 2), scale(0.085, 0.08, 0.085)), col);
        if (rec > 0.55) {
          const f = (rec - 0.55) / 0.45;
          draw(M.sphere, chain(head, translate(side * 0.6, -0.02, 0.58), scale(0.06 + 0.12 * f)), FLASH, 1);
        }
      });

      // team number badge on front plate (only rendered when r.label is set)
      if (r.label != null) {
        const sf = 1.1;
        const on = DIGITS[r.label % 10];
        for (const [seg, [sx, sy, sw, sh]] of Object.entries(SEGMENTS)) {
          const m = chain(body, translate(sx * sf, -0.02 + sy * sf, 0.465), scale(sw * sf, sh * sf, 0.01));
          if (on.includes(seg)) draw(M.slab, m, [1, 1, 1], 1.0);
          else draw(M.slab, m, SEG_OFF);
        }
      }

      // springy antenna
      const wobZ = Math.sin(time * 7 + seed) * 0.05 * (0.3 + moving) - (r.turnRate ?? 0) * 0.12;
      const wobX = -moving * 0.18 + Math.sin(time * 5 + seed) * 0.04 + recoil * 0.3;
      draw(M.sphere, chain(head, translate(0, 0.3, -0.05), scale(0.07, 0.04, 0.07)), METAL);
      const ant = chain(head, translate(0, 0.3, -0.05), rotZ(wobZ), rotX(wobX));
      draw(M.cyl, chain(ant, translate(0, 0.15, 0), scale(0.025, 0.3, 0.025)), METAL);
      draw(M.sphere, chain(ant, translate(0, 0.33, 0), scale(0.075)), BULB, 0.7 + 0.3 * Math.sin(time * 3 + seed));

      // life sign on a post behind the antenna
      if (r.hp !== undefined) {
        draw(M.cyl, chain(head, translate(0, 0.575, -0.28), scale(0.022, 0.55, 0.022)), METAL);
        const top = chain(head, translate(0, 0.85, -0.28));
        const sway = Math.sin(time * 3 + seed) * 0.04 + (r.hit ?? 0) * Math.sin(time * 40) * 0.25;
        flash = 0;
        drawSign([top[12], top[13], top[14]], r.hp, r.maxHp ?? 10, col, sway, s, time);
      }

      flash = 0;
    }

    // A small board that always turns to face the camera, showing a heart and the life count.
    function drawSign(pos, hp, maxHp, col, sway, s, time) {
      const [px, py, pz] = pos;
      const yaw = Math.atan2(eyePos[0] - px, eyePos[2] - pz);
      const tilt = Math.atan2(eyePos[1] - py, Math.hypot(eyePos[0] - px, eyePos[2] - pz));
      const board = chain(translate(px, py, pz), rotY(yaw), rotX(-tilt), rotZ(sway), scale(s), translate(0, 0.18, 0));
      draw(M.signFrame, board, lighten(col, 0.6));
      draw(M.signScreen, chain(board, translate(0, 0, 0.03)), SCREEN);

      const hx = -0.17;
      draw(M.cube, chain(board, translate(hx, -0.012, 0.04), rotZ(Math.PI / 4), scale(0.075, 0.075, 0.02)), HEART, 0.8);
      for (const side of [-1, 1])
        draw(M.sphere, chain(board, translate(hx + side * 0.027, 0.018, 0.04), scale(0.042, 0.042, 0.01)), HEART, 0.8);

      const value = Math.max(0, Math.min(99, Math.ceil(hp)));
      const lit = healthColor(hp / maxHp);
      const glow = value === 0 && Math.sin(time * 20) < 0 ? 0.25 : 1;
      const digits = [value >= 10 ? Math.floor(value / 10) : -1, value % 10];
      digits.forEach((d, i) => {
        const on = d >= 0 ? DIGITS[d] : '';
        for (const [seg, [x, y, w, h]] of Object.entries(SEGMENTS)) {
          const m = chain(board, translate(0.02 + i * 0.16 + x, y, 0.045), scale(w, h, 0.01));
          if (on.includes(seg)) draw(M.slab, m, lit, glow);
          else draw(M.slab, m, SEG_OFF);
        }
      });
    }

    function drawWalls(walls) {
      flash = 0;
      for (const w of walls) {
        const cx = (w.x0 + w.x1) / 2, cz = (w.z0 + w.z1) / 2, sx = w.x1 - w.x0, sz = w.z1 - w.z0;
        draw(M.slab, chain(translate(cx, WALL_HEIGHT / 2, cz), scale(sx, WALL_HEIGHT, sz)), INNER_WALL);
        draw(M.slab, chain(translate(cx, WALL_HEIGHT, cz), scale(sx + 0.08, 0.08, sz + 0.08)), lighten(INNER_WALL, 0.35));
      }
    }

    // A wedge of light on the floor along the robot's last scan. Brighter, with a ping at the
    // far end, when it found something; otherwise faint and stopped by the first wall.
    function drawRadar(r) {
      const sc = r.scan;
      if (!sc || sc.age > RADAR_FADE || r.dying !== null && r.dying !== undefined) return;
      const fade = 1 - sc.age / RADAR_FADE;
      const half = Math.tan(sc.width / 2) * sc.range;
      flash = 0;
      drawGlow(M.fan, chain(translate(r.x, 0.03, r.z), rotY(sc.angle), scale(half, 1, sc.range)),
        r.color.map((v) => v * 0.85), (sc.found ? 0.75 : 0.4) * fade);
      if (sc.found) {
        const px = r.x + Math.sin(sc.angle) * sc.range, pz = r.z + Math.cos(sc.angle) * sc.range;
        drawGlow(M.disc, chain(translate(px, 0.04, pz), scale(1.1)), r.color.map((v) => v * 0.85), 0.8 * fade);
      }
    }

    function drawImpact(i) {
      const k = Math.max(0, 1 - i.age / IMPACT_TIME);
      flash = 0;
      draw(M.sphere, chain(translate(i.x, i.y, i.z), scale(0.08 + 0.25 * (1 - k))), FLASH, k);
    }

    function drawBullet(b) {
      drawShadow(b.x, b.z, 0.18, 0.3);
      draw(M.sphere, chain(translate(b.x, b.y, b.z), scale(0.13)), BULLET);
    }

    // Fireball plus flying scrap. e = { x, z, age, color, seed }; finished when age >= EXPLOSION_TIME.
    function drawExplosion(e) {
      const { x, z, age } = e;
      const seed = e.seed ?? 0;
      const fade = Math.max(0, 1 - age / EXPLOSION_TIME);
      flash = 0;
      drawShadow(x, z, 1.3, 0.55 * fade);

      const ball = age < 0.12 ? age / 0.12 : Math.max(0, 1 - (age - 0.12) / 0.4);
      if (ball > 0) {
        const heat = Math.min(1, age / 0.4);
        draw(M.sphere, chain(translate(x, 0.9, z), scale(1.3 * ball)), FLASH.map((v, i) => v + (FIRE[i] - v) * heat), 1);
      }

      const shrink = Math.min(1, (EXPLOSION_TIME - age) / 0.3);
      const colors = [e.color, TREAD, METAL];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + seed;
        const hs = 2 + ((i * 7) % 5) * 0.5, vy = 3 + ((i * 3) % 4);
        const y = Math.max(0.08, 0.9 + vy * age - 4.9 * age * age);
        const m = chain(translate(x + Math.cos(a) * hs * age, y, z + Math.sin(a) * hs * age),
          rotX(age * (5 + i)), rotZ(age * (3 + i)), scale(0.17 * shrink));
        draw(M.cube, m, colors[i % 3]);
      }
    }

    return { begin, drawArena, drawWalls, drawRadar, drawRobot, drawBullet, drawImpact, drawExplosion, drawShadow };
  }

  global.RobotGfx = { create, mat4, EXPLOSION_TIME, IMPACT_TIME, WALL_HEIGHT };
})(window);
