// Cute battle robot renderer for WebGL2. No dependencies.
//
// Usage:
//   const gfx = RobotGfx.create(gl);
//   gfx.begin(viewProj, eye);          // once per frame
//   gfx.drawArena(halfSize, ground?);              // ground = { layer, tile } textures the floor; else checkered
//   gfx.drawRobot(robot, time);        // see ROBOT STATE below
//   gfx.drawBullet(bullet);
//   gfx.drawExplosion({ x, z, age, color, seed });  // done when age >= RobotGfx.EXPLOSION_TIME
//   gfx.loadTextures([url, ...]);                  // 512x512 photos (facades, ground); layer = index
//   gfx.drawWalls([{ x0, z0, x1, z1, h?, color?, facade?, hp?, maxHp? }, ...]); // interior walls, axis-aligned boxes;
//                                                  // facade = { layer, tile, tint } picks a loaded photo
//   gfx.drawRadar(robot);                          // the robot's last radar scan, if any (robot.scan)
//   gfx.drawImpact({ x, y, z, age });               // bullet hitting a wall; done after IMPACT_TIME
//   gfx.drawCrumble({ x0, z0, x1, z1, seed, age }); // a wall block falling apart; done after CRUMBLE_TIME
//   gfx.drawMine({ x, z, seed }, time);             // a land mine on the floor
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

  // Unit cube centred on the origin with sharp edges, so neighbouring blocks join without seams.
  function box() {
    const data = [], idx = [];
    for (const [n, u, v] of [[[1, 0, 0], [0, 0, 1], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
                             [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
                             [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]]]) {
      const base = data.length / 6;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        data.push(...[0, 1, 2].map((k) => (n[k] + u[k] * a + v[k] * b) / 2), ...n);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

  // uMode: 0 = lit part, 1 = soft blob shadow, 2 = checkered floor, 3 = glow, 4 = textured facade, 5 = puff,
  // 6 = textured ground, 7 = radio-wave ring (transparent centre, bright ring near outer edge)
  const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec3 vNor, vWorld, vLocal;
uniform vec3 uColor, uEye;
uniform float uEmissive, uFlash, uAlpha, uLayer, uTile, uTop;
uniform int uMode;
uniform sampler2DArray uTex;
out vec4 outColor;
void main() {
  if (uMode == 3) {
    // translucent glow (radar beam / ping) that fades away from the origin
    float a = uAlpha * (1.0 - 0.7 * smoothstep(0.0, 1.0, length(vLocal.xz)));
    outColor = vec4(uColor, a);
    return;
  }
  if (uMode == 7) {
    // radio-wave ring: transparent at centre, bright near outer edge, sharp fade at rim
    float r = length(vLocal.xz);
    float a = uAlpha * smoothstep(0.55, 0.8, r) * (1.0 - smoothstep(0.88, 1.0, r));
    outColor = vec4(uColor, a);
    return;
  }
  if (uMode == 5) {
    // soft round puff (smoke, flame): fades toward the silhouette from any viewing angle
    float a = uAlpha * pow(max(dot(normalize(vNor), normalize(uEye - vWorld)), 0.0), 2.0);
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
  if (uMode == 6) {
    base = texture(uTex, vec3(vWorld.xz / uTile, uLayer)).rgb * uColor;
    shiny = 0.0;
  }
  if (uMode == 4) {
    // Facade photo on the walls, in world coordinates so it runs on across neighbouring blocks
    // and every storey starts at the ground; uColor tints it (damage darkens). Flat roofs.
    // Snap the normal to the main axis so the blocks' bevelled edges don't show as seams.
    vec3 a = abs(N);
    N = a.y > a.x && a.y > a.z ? vec3(0.0, sign(N.y), 0.0) : a.x > a.z ? vec3(sign(N.x), 0.0, 0.0) : vec3(0.0, 0.0, sign(N.z));
    // Everything at the very top is roof, so the hairline gaps between neighbouring blocks'
    // rounded edges show roof instead of the blocks' inner walls.
    if (abs(N.y) < 0.5 && vWorld.y < uTop - 0.03) {
      float u = abs(N.x) > abs(N.z) ? vWorld.z : vWorld.x;
      base = texture(uTex, vec3(vec2(u, -vWorld.y) / uTile, uLayer)).rgb * uColor * 1.4;
    } else {
      base = vec3(0.62, 0.62, 0.6) * uColor;
      N = vec3(0.0, 1.0, 0.0);
    }
    shiny = 0.15;
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
  const CRUMBLE_TIME = 3;
  const RADIO_PULSE_TIME = 1.0;

  function create(gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    for (const n of ['uViewProj', 'uModel', 'uColor', 'uEye', 'uEmissive', 'uFlash', 'uAlpha', 'uMode', 'uLayer', 'uTile', 'uTop', 'uTex'])
      u[n] = gl.getUniformLocation(prog, n);

    // Photo textures (building facades, ground) live in one texture array, one layer each.
    // Layers start mid-grey and fill in as the images arrive. All images must be TEX_SIZE square.
    const TEX_SIZE = 512;
    let texArray = null;
    function loadTextures(urls) {
      texArray = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
      const levels = Math.log2(TEX_SIZE) + 1;
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, TEX_SIZE, TEX_SIZE, urls.length);
      const grey = new Uint8Array(TEX_SIZE * TEX_SIZE * 4).fill(150);
      for (let i = 0; i < urls.length; i++)
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, TEX_SIZE, TEX_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, grey);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      urls.forEach((url, i) => {
        const img = new Image();
        img.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, TEX_SIZE, TEX_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        };
        img.src = url;
      });
    }

    const M = {
      cube: upload(gl, roundedBox(1, 1, 1, 0.08, 2)),
      slab: upload(gl, roundedBox(1, 1, 1, 0.002, 1)),
      box: upload(gl, box()),
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

    function drawGlow(mesh, model, color, alpha, mode = 3, additive = false) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(u.uAlpha, alpha);
      draw(mesh, model, color, 0, mode);
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
      gl.uniform1i(u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
      eyePos = eye;
      flash = 0;
    }

    function drawArena(half, ground) {
      flash = 0;
      const floor = chain(translate(0, -0.1, 0), scale(half * 2, 0.2, half * 2));
      if (ground && texArray) {
        gl.uniform1f(u.uLayer, ground.layer);
        gl.uniform1f(u.uTile, ground.tile);
        draw(M.slab, floor, [1, 1, 1], 0, 6);
      } else draw(M.slab, floor, FLOOR, 0, 2);
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
      // A building whose blocks are all there and unhurt is drawn as one box: cheaper, and no
      // seams where its blocks meet.
      const intact = new Map();
      for (const w of walls)
        if (w.building && w.hp === (w.maxHp || Infinity)) intact.set(w.building, (intact.get(w.building) ?? 0) + 1);
      const drawn = new Set();
      for (const w of walls) {
        const b = w.building;
        if (b && intact.get(b) === b.blocks) {
          if (drawn.has(b)) continue;
          drawn.add(b);
          gl.uniform1f(u.uLayer, w.facade.layer);
          gl.uniform1f(u.uTile, w.facade.tile);
          gl.uniform1f(u.uTop, w.h);
          const t = w.facade.tint;
          draw(M.box, chain(translate((b.x0 + b.x1) / 2, w.h / 2, (b.z0 + b.z1) / 2), scale(b.x1 - b.x0, w.h, b.z1 - b.z0)), [t, t, t], 0, 4);
          continue;
        }
        const cx = (w.x0 + w.x1) / 2, cz = (w.z0 + w.z1) / 2, sx = w.x1 - w.x0, sz = w.z1 - w.z0;
        // Damaged blocks sink and darken, so you can see which ones are about to go.
        const f = w.maxHp ? w.hp / w.maxHp : 1, h = (w.h ?? WALL_HEIGHT) * (0.45 + 0.55 * f);
        if (w.facade && texArray) {
          // w.facade = { layer, tile, tint }: which photo, how many world units one copy covers
          const tint = w.facade.tint * (0.7 + 0.3 * f);
          gl.uniform1f(u.uLayer, w.facade.layer);
          gl.uniform1f(u.uTile, w.facade.tile);
          gl.uniform1f(u.uTop, h);
          // A hair oversized, so rounding can't open cracks between neighbouring blocks.
          draw(M.box, chain(translate(cx, h / 2, cz), scale(sx + 0.01, h, sz + 0.01)), [tint, tint, tint], 0, 4);
          continue;
        }
        const col = (w.color ?? INNER_WALL).map((v) => v * (0.7 + 0.3 * f));
        draw(M.slab, chain(translate(cx, h / 2, cz), scale(sx, h, sz)), col);
        draw(M.slab, chain(translate(cx, h, cz), scale(sx + 0.08, 0.08, sz + 0.08)), lighten(col, 0.35));
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

    function drawShell(b) {
      flash = 0;
      drawShadow(b.x, b.z, 0.25, 0.25 * Math.min(1, b.y * 0.4));
      draw(M.sphere, chain(translate(b.x, b.y, b.z), scale(0.22)), [0.32, 0.30, 0.26]);
      const g = b.gravity ?? 10;
      for (let i = 1; i <= 7; i++) {
        const td = i * 0.05;
        const tx = b.x - b.vx * td, tz = b.z - b.vz * td;
        const ty = b.y - (b.vy ?? 0) * td - 0.5 * g * td * td;
        if (ty < 0) break;
        drawGlow(M.sphere, chain(translate(tx, Math.max(0.05, ty), tz), scale(0.07 + i * 0.025)),
          [0.55, 0.52, 0.48], (1 - i / 8) * 0.45, 5);
      }
      // Impact prediction ring: shrinks from blast radius to a point as shell approaches
      if (b.lifeMax > 0) {
        const vy = b.vy ?? 0;
        const disc = vy * vy + 2 * g * b.y;
        if (disc >= 0) {
          const tLand = (vy + Math.sqrt(disc)) / g;
          const lx = b.x + b.vx * tLand, lz = b.z + b.vz * tLand;
          const frac = Math.min(1, tLand / b.lifeMax);
          const r = frac * 3.0;
          if (r > 0.05) {
            drawGlow(M.disc, chain(translate(lx, 0.04, lz), scale(r, 1, r)),
              b.color, 0.25 + 0.45 * frac, 7);
          }
        }
      }
    }

    // A little missile pointing the way it flies, with a flickering flame and a smoke trail
    // that never reaches back past the launch point (x0, z0).
    function drawBullet(b) {
      if (b.howitzer) { drawShell(b); return; }
      const yaw = Math.atan2(b.vx, b.vz), dx = Math.sin(yaw), dz = Math.cos(yaw);
      const at = (d, y = b.y) => translate(b.x + dx * d, y, b.z + dz * d);
      const flown = b.x0 === undefined ? 3 : Math.hypot(b.x - b.x0, b.z - b.z0);
      const t = b.life ?? 0, col = b.color ?? BULLET;
      flash = 0;
      drawShadow(b.x, b.z, 0.2, 0.3);

      draw(M.cyl, chain(at(-0.05), rotY(yaw), rotX(Math.PI / 2), scale(0.075, 0.5, 0.075)), METAL);
      draw(M.sphere, chain(at(0.2), rotY(yaw), scale(0.075, 0.075, 0.16)), col);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        draw(M.cube, chain(at(-0.24), rotY(yaw), rotZ(a), translate(0, 0.09, 0), scale(0.02, 0.12, 0.14)), col);
      }

      // smoke first (behind the flame): grey puffs that swell, rise a little and fade
      for (let i = 8; i >= 0; i--) {
        const d = 0.85 + i * 0.32;
        if (d > flown) continue;
        const k = i / 9, wob = Math.sin(t * 9 + i * 1.7) * 0.03;
        drawGlow(M.sphere, chain(at(-d, b.y + k * 0.2 + wob), scale(0.12 + k * 0.22)), [0.42, 0.42, 0.45], 0.55 * (1 - k), 5);
      }
      // flame: a flickering orange-to-red plume around a white-hot core
      const flick = (i) => 0.75 + 0.25 * Math.sin(t * 70 + i * 2.1);
      const plume = [[1, 0.75, 0.15], [1, 0.5, 0.05], [0.95, 0.32, 0.03], [0.8, 0.2, 0.02]];
      for (let i = 3; i >= 0; i--) {
        const d = 0.38 + i * 0.13, r = (0.16 - i * 0.022) * flick(i + 1);
        if (d > flown) continue;
        drawGlow(M.sphere, chain(at(-d), rotY(yaw), scale(r, r, r * 1.4)), plume[i], 1 - i * 0.15, 5);
      }
      draw(M.sphere, chain(at(-0.33), rotY(yaw), scale(0.055 * flick(0), 0.055 * flick(0), 0.09)), [1, 0.95, 0.7], 1);
    }

    // Fireball plus flying scrap. e = { x, z, age, color, seed, scale? }; finished when age >= EXPLOSION_TIME.
    function drawExplosion(e) {
      const { x, z, age } = e;
      const seed = e.seed ?? 0;
      const s = e.scale ?? 1;
      const fade = Math.max(0, 1 - age / EXPLOSION_TIME);
      flash = 0;
      drawShadow(x, z, 1.3 * s, 0.55 * fade);

      const ball = age < 0.12 ? age / 0.12 : Math.max(0, 1 - (age - 0.12) / 0.4);
      if (ball > 0) {
        const heat = Math.min(1, age / 0.4);
        draw(M.sphere, chain(translate(x, 0.9 * s, z), scale(1.3 * s * ball)), FLASH.map((v, i) => v + (FIRE[i] - v) * heat), 1);
      }

      const shrink = Math.min(1, (EXPLOSION_TIME - age) / 0.3);
      const colors = [e.color, TREAD, METAL];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + seed;
        const hs = (2 + ((i * 7) % 5) * 0.5) * s, vy = (3 + ((i * 3) % 4)) * s;
        const y = Math.max(0.08, 0.9 * s + vy * age - 4.9 * age * age);
        const m = chain(translate(x + Math.cos(a) * hs * age, y, z + Math.sin(a) * hs * age),
          rotX(age * (5 + i)), rotZ(age * (3 + i)), scale(0.17 * s * shrink));
        draw(M.cube, m, colors[i % 3]);
      }
    }

    // A land mine: a squat dark disc with a little red light that blinks. m = { x, z, seed }.
    function drawMine(m, time) {
      flash = 0;
      draw(M.cyl, chain(translate(m.x, 0.06, m.z), scale(0.34, 0.12, 0.34)), [0.25, 0.27, 0.22]);
      draw(M.cyl, chain(translate(m.x, 0.13, m.z), scale(0.2, 0.04, 0.2)), METAL);
      const on = (time * 1.5 + (m.seed ?? 0)) % 1 < 0.25;
      draw(M.sphere, chain(translate(m.x, 0.17, m.z), scale(0.06)), on ? [1, 0.15, 0.1] : [0.35, 0.08, 0.06], on ? 1 : 0);
    }

    // A wall block collapsing: chunks pop up, tumble and fall, and a pile of rubble settles and
    // fades. c = { x0, z0, x1, z1, maxHp, seed, age }; finished when age >= CRUMBLE_TIME.
    function drawCrumble(c) {
      const { age } = c, seed = c.seed ?? 0;
      const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2, sx = c.x1 - c.x0, sz = c.z1 - c.z0;
      const shrink = Math.min(1, (CRUMBLE_TIME - age) / 0.5);
      const h0 = (c.h ?? WALL_HEIGHT) * 0.45, base = c.color ?? INNER_WALL;
      flash = 0;
      const dust = Math.max(0, 1 - age / 0.6);
      if (dust > 0) drawGlow(M.sphere, chain(translate(cx, h0 * 0.6, cz), scale((sx + sz) * 0.4 * (1 + age * 1.5))), lighten(base, 0.5), 0.45 * dust);
      for (let i = 0; i < 14; i++) {
        const r1 = Math.sin(seed * 13.1 + i * 7.3) * 0.5 + 0.5, r2 = Math.sin(seed * 5.7 + i * 3.1) * 0.5 + 0.5;
        const ox = (r1 - 0.5) * sx, oz = (r2 - 0.5) * sz, ys = (i % 3) / 3 * h0 + 0.15;
        const vx = (r1 - 0.5) * 3, vz = (r2 - 0.5) * 3, vy = 1.5 + (i % 4) * 0.7;
        const t = age, size = 0.18 + ((i * 5) % 4) * 0.06;
        const y = Math.max(size / 2, ys + vy * t - 4.9 * t * t);
        const settle = y <= size / 2 ? 0 : 1;
        const tf = Math.min(t, 0.5);
        const m = chain(translate(cx + ox + vx * tf * 0.6, y, cz + oz + vz * tf * 0.6),
          rotX(settle * t * (4 + i) + i), rotZ(settle * t * (3 + i) + i * 0.5), scale(size * shrink));
        draw(M.cube, m, base.map((v) => v * (0.65 + 0.1 * (i % 3))));
      }
    }

    function drawRadioPulse(p) {
      const k = p.age / RADIO_PULSE_TIME;
      if (k >= 1) return;
      flash = 0;
      const r = 2 + k * 10;
      drawGlow(M.disc, chain(translate(p.x, 0.05, p.z), scale(r, 1, r)), p.color, (1 - k) * 0.82, 7);
    }

    return { begin, drawArena, drawWalls, drawRadar, drawRobot, drawBullet, drawImpact, drawExplosion, drawCrumble, drawMine, drawShadow, loadTextures, drawRadioPulse };
  }

  global.RobotGfx = { create, mat4, EXPLOSION_TIME, IMPACT_TIME, CRUMBLE_TIME, RADIO_PULSE_TIME, WALL_HEIGHT };
})(window);
