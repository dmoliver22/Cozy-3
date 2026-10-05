import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';

// Short dense fur on the skin itself (shell texturing): the skin mesh is drawn a few more times,
// each layer pushed a little further out along the normal and combed along the coat, and each
// layer only keeps the pixels where a hair is still there at that height. Hairs are procedural
// (random fibres in a fine 3D grid on the resting skin), thinner and lighter toward their tips,
// darker down at the skin. This is what makes faces, legs and short coats read as fur, while the
// long hair grows from the guide strands on top.
//
// Needs two attributes on the geometry: aFurLen (how tall the short fur is, m) and aComb (the way
// the coat lies, in the mesh's own space).

const SHELL_VERT = /* glsl */ `
attribute float aFurLen;
attribute vec3 aComb;
uniform float uShell;
uniform float uFlat;
varying vec3 vBase;
varying float vShellT;
`;

const SHELL_FRAG = /* glsl */ `
uniform float uShell;
uniform float uCell;
varying vec3 vBase;
varying float vShellT;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
`;

function shellMaterial(base, shell, uniforms) {
  const mat = base.clone();
  mat.alphaToCoverage = true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uShell: { value: shell } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SHELL_VERT}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBase = position;
        float sh = uShell * aFurLen * (1.0 - 0.6 * uFlat);
        transformed += normal * sh + aComb * (uShell * uShell * aFurLen * 0.9);
        vShellT = uShell;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SHELL_FRAG}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Two hairs per cell of a fine 3D grid on the resting skin.
          vec3 q = vBase / uCell;
          vec3 id = floor(q), f = fract(q);
          vec3 h1 = hash33(id), h2 = hash33(id + 17.31);
          float d1 = length(f - (0.15 + 0.7 * h1)), d2 = length(f - (0.15 + 0.7 * h2));
          float t = vShellT;
          // Each hair has its own height; it thins toward the tip.
          float r1 = 0.36 * (1.0 - 0.75 * t) * step(t, 0.45 + 0.55 * h1.z);
          float r2 = 0.36 * (1.0 - 0.75 * t) * step(t, 0.45 + 0.55 * h2.z);
          float a1 = r1 > 0.0 ? 1.0 - smoothstep(r1 - fwidth(d1), r1 + fwidth(d1), d1) : 0.0;
          float a2 = r2 > 0.0 ? 1.0 - smoothstep(r2 - fwidth(d2), r2 + fwidth(d2), d2) : 0.0;
          float a = max(a1, a2);
          if (a < 0.02) discard;
          diffuseColor.a *= a;
          float jit = a1 > a2 ? h1.y : h2.y;
          diffuseColor.rgb *= (0.5 + 0.55 * t) * (0.88 + 0.24 * jit);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'dog-shell-1';
  return mat;
}

// Add shell layers for a mesh. Skinned meshes share the skeleton; plain meshes share the parent.
export function addShells(mesh, uniforms, count = QUALITY.shells) {
  const layers = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const m = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, shellMaterial(mesh.material, t, uniforms)) : new THREE.Mesh(mesh.geometry, shellMaterial(mesh.material, t, uniforms));
    if (mesh.isSkinnedMesh) m.bind(mesh.skeleton, mesh.bindMatrix);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.userData.layer = i;
    layers.push(m);
  }
  return layers;
}

export function shellUniforms(cell) {
  return { uCell: { value: cell }, uFlat: { value: 0 } };
}
