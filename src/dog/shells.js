import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';

// Short dense fur on the skin itself (shell texturing): the skin mesh is drawn a dozen more times,
// each layer pushed a little further out and leaning over along the coat, and each layer keeps
// only the pixels where a hair still reaches that high. Hairs are procedural (fibres in a fine 3D
// grid on the resting skin), so every hair is a slanted line through the layers: seen from above,
// a short coat reads as hair lying flat in the way it grows, not as dots on skin. Hairs taper
// toward their tips and are darker down at the roots.
//
// Needs two attributes on the geometry: aFurLen (length of the short fur, m) and aComb (the way the
// coat lies, in the mesh's own space, scaled by how far it leans over: 1 flat, 0 upright).

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
        // Lying-flat coats lean far over and stand low; a soaked coat lies flatter still.
        float lean = length(aComb);
        float up = mix(0.75, 0.3, lean) * (1.0 - 0.3 * uFlat);
        transformed += normal * (uShell * aFurLen * up) + aComb * (pow(uShell, 1.4) * aFurLen * (1.0 + 0.2 * uFlat));
        vShellT = uShell;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SHELL_FRAG}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Two hairs per cell of a fine 3D grid on the resting skin, each with its own height,
          // thinning toward the tip.
          vec3 q = vBase / uCell;
          vec3 id = floor(q), f = fract(q);
          float t = vShellT, a = 0.0, jit = 0.0;
          for (int k = 0; k < 2; k++) {
            vec3 h = hash33(id + float(k) * 17.31);
            float d = length(f - (0.15 + 0.7 * h));
            float r = 0.5 * pow(1.0 - t, 0.5) * step(t, 0.55 + 0.45 * h.z);
            float fw = fwidth(d);
            float ak = r > 0.0 ? 1.0 - smoothstep(r - fw, r + fw, d) : 0.0;
            if (ak > a) { a = ak; jit = h.y; }
          }
          // Seen edge-on, the separate layers would show as slices: fade them out there.
          a *= smoothstep(0.06, 0.3, abs(dot(normalize(vNormal), normalize(vViewPosition))));
          if (a < 0.02) discard;
          diffuseColor.a *= a;
          // Shadowed down in the pile, lighter toward the tips, a little different hair to hair.
          diffuseColor.rgb *= (0.8 + 0.35 * t) * (0.88 + 0.24 * jit);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'dog-shell-3';
  return mat;
}

// Add shell layers for a mesh. Skinned meshes share the skeleton; plain meshes share the parent.
export function addShells(mesh, uniforms, count = QUALITY.shells) {
  const layers = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const mat = shellMaterial(mesh.material, t, uniforms);
    const m = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, mat) : new THREE.Mesh(mesh.geometry, mat);
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
