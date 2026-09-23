# Racing source car assets

The files in this directory are immutable source assets. Runtime builds must only reference
converted files under `public/assets`.

> **The source GLBs are excluded from the public repository.** `data/` is gitignored except for
> this file, so the sources are **not** present in a clone. Only the converted runtime files under
> `public/assets` are published; the game runs from those alone. `npm run prepare:cars` and the
> source-side checks in `npm run check:cars` therefore require the original sources, which are
> available from the repository owner. Everything below documents the conversion so it stays
> reproducible once the sources are restored to `data/`.

| Source | Added | Recorded origin | SHA-256 | Geometry | Raw front axis |
| --- | --- | --- | --- | --- | --- |
| `gen3_car_tripo.glb` | 2026-09-09 | Tripo3D-generated project-provided asset | `2748483e13ea15abaf23ca1a131e0627ac5ed47133d4605f28e634c417008661` | 964 triangles / 1,101 vertices | `+Z`, yawed 32.4° |
| `gen4_car_tripo.glb` | 2026-09-09 | Tripo3D-generated project-provided asset | `34840cb145c72d2abc13443b44e7bbb2afa039f57bcbeae5ced483339051fe10` | 7,997 triangles / 9,977 vertices | `+Z`, yawed 34.4° |
| `gen3_car.glb` | 2026-08-11 | Meshy-derived project-provided asset (`ebed515`) | `5e48569c625a00cf549069be7eb90b9bd6e87b23164bb92ad06480ee84a76c2e` | 978 triangles / 1,769 vertices | `-X` |
| `gen4_car.glb` | 2026-08-11 | Meshy-derived project-provided asset (`ebed515`) | `b00d08a2f81790a39bdd8fb6f5c2214cb0bf0b15a1c61edc033fbb00de846c94` | 13,618 triangles / 13,396 vertices | `-X` |

The two `*_tripo.glb` files replaced the Meshy sources on 2026-09-09 (`Docs/REPLACE_DATA_PLAN.md`).
The superseded sources are kept — nothing in `data/` is ever deleted or overwritten — but they are
no longer referenced by `car-conversion.json`. No additional license text was stored with any of the
supplied files, so they are treated as project-owned inputs and must not be redistributed
independently from this repository without owner confirmation.

Conversion rules:

- Never overwrite any source GLB.
- **Bake the normalization into the runtime GLB.** The runtime `TransformCommand` carries only
  `rotationY` and a uniform scale, so the source pose and dimensions have to be corrected here:
  1. undo the yaw and turn the front onto `-X` (`normalize.yawDegrees`, then −90°);
  2. move the centre of the bounds to the origin — the sources sit on `Y = 0`, and leaving that
     alone makes the car sink into the road;
  3. scale left/right and up/down by one factor and front/back by another, so the model lands on
     `CAR_LENGTH` × `CAR_WIDTH` at runtime rather than being 0.4 m shorter than its own collision box;
  4. rotate the normals and renormalize them through the inverse transpose of the anisotropic scale.
  The constants live in `normalize` in `car-conversion.json`; the tool never searches for them.
- Preserve POSITION, NORMAL, TEXCOORD_0, indices and the triangle count. **Bounds are not
  preserved** — they are the output of the normalization, recomputed from the Float32 positions and
  written back into both the accessor `min`/`max` and the record.
- **Split the wheels out of the body and bake their rotation phases** (phase 12-7). The runtime
  `TransformCommand` has only `rotationY`, so a wheel can never be spun about its axle at runtime.
  The converter finds the four wheels as connected components (the sources keep them as separate
  shells: 4 in gen3, 6 plus two hub caps per axle in gen4), writes the body without them to
  `car.glb`, and writes `car_wheels_<phase>.glb` for each of the 8 phases. The rotation happens in
  the *source* space — the normalization stretches front/back by ~1.10, so rotating the resulting
  ellipse rigidly makes the outline wobble (bounds drift 0.0160 / 0.0239 model units against
  0.0050 / 0.0110 when the anisotropy is undone first). The split is lossless: body plus phase 0
  add back up to the triangle and vertex counts recorded in `geometry`, which still describes the
  whole car — that is what keeps `CAR_MODELS.bounds` (and the ground offset taken from it) honest.
  The measured axle centres and wheel radius are recorded in `runtime.wheels`.
- Remove material, image and unused vertex attributes from runtime GLBs.
- **Decode the embedded base color and rebuild the runtime texture** (`tools/lib/jpeg.mjs` for the
  baseline JPEG the sources carry, then an integer box downscale and `tools/lib/png.mjs`).
- Normalize an identity `node.matrix` to implicit identity TRS.

Rebuild and verify the runtime copies from the repository root (the repository root is the
application root — see `Docs/IMPLEMENTATION_PLAN.md` §2.4):

```sh
npm run prepare:cars            # reconvert in memory and compare against the committed files
npm run prepare:cars -- --write # actually overwrite the runtime GLBs and the record
npm run check:cars              # SHA-256 of every recorded file
```

`tools/build-car-lamps.mjs` (`npm run build:lamps`) then reads the runtime body and the greyscale
paint texture and bakes `car_lamps.glb` — two surface-hugging strips on the rear panel, measured
from the rear-facing vertices. Tail lamps cannot come from the texture: the paint texture flattens
the source's red lamps to grey, and `MaterialCommand.emissiveTexture` exists in the type but is
never read by the renderer. The strips sample one bright neutral texel, so the lamp colour is a
single runtime multiply (dim when coasting, bright under braking) and no texture is added.

`check:cars` verifies the source GLB, the runtime body, every wheel phase and the runtime texture
for each generation, so **on a fresh clone it fails**: the two source entries report `ENOENT` and the
script exits with status 1, even though the runtime files it also checks are intact. That is
expected without the sources in `data/`. To verify only what a clone actually ships, check the
runtime files and skip the source entries; a full pass requires restoring the sources first.

The paths in `public/assets/car-conversion.json` are repository-root relative, so both tools read
them as-is. `prepare:cars` reproduces every runtime GLB — the body and all eight wheel
phases per generation — **byte for byte** from the sources, and running it twice produces identical
output.

One limit is worth stating plainly:

- **`geometry.fingerprint` is gone** (record `version` 2). It was described as a renderer-canonical
  fingerprint, and that canonicalization cannot be recovered from the artifacts alone, so it was
  never rewritten. Carrying a stale fingerprint over to a new shape is worse than carrying none;
  `bytes` and `sha256` pin the files well enough on their own.

The base color textures **are** rebuilt from the sources now. `tools/lib/jpeg.mjs` is a minimal
baseline JPEG decoder written for this — the same "only what this project actually reads" approach
`tools/lib/png.mjs` takes with PNG — so no image-codec dependency was added. Against macOS `sips`
the luma agrees to 0.12–0.17 per channel; the residual sits on chroma edges, where 4:2:0 upsampling
kernels legitimately differ.

`public/assets/car-conversion.json` is the deterministic conversion record. It stores source/runtime
SHA-256 values, the normalization constants, triangle/vertex counts, bounds, texture dimensions, and
file sizes. Two consecutive conversion runs on 2026-09-09 produced byte-identical GLBs, textures,
and records.
