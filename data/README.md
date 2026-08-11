# Racing source car assets

`gen3_car.glb` and `gen4_car.glb` are immutable source assets. Runtime builds must only reference converted files under `apps/racing/public/assets`.

| Source | Added | Recorded origin | SHA-256 | Geometry | Front axis |
| --- | --- | --- | --- | --- | --- |
| `gen3_car.glb` | 2026-08-11 | Meshy-derived project-provided asset (`ebed515`) | `5e48569c625a00cf549069be7eb90b9bd6e87b23164bb92ad06480ee84a76c2e` | 978 triangles / 1,769 vertices | `-X` |
| `gen4_car.glb` | 2026-08-11 | Meshy-derived project-provided asset (`ebed515`) | `b00d08a2f81790a39bdd8fb6f5c2214cb0bf0b15a1c61edc033fbb00de846c94` | 13,618 triangles / 13,396 vertices | `-X` |

The `-X` front axis is fixed by the Blender end-view preflight images in `Docs/measurements/racing-renewal`. No additional license text was stored with the supplied files, so they are treated as project-owned inputs and must not be redistributed independently from this repository without owner confirmation.

Conversion rules:

- Never overwrite either source GLB.
- Preserve POSITION, NORMAL, TEXCOORD_0, indices, triangle count, bounds, and canonical geometry fingerprint.
- Remove unused normal and metallic/roughness images from runtime GLBs.
- Extract and resize the base color as an external runtime texture.
- Normalize the Gen4 identity `node.matrix` to implicit identity TRS.

Rebuild and verify the runtime copies from the workspace root:

```sh
npm run prepare:cars -w @console-chaos/racing
npm run check:cars -w @console-chaos/racing
```

`public/assets/car-conversion.json` is the deterministic conversion record. It stores source/runtime SHA-256 values, renderer-canonical geometry fingerprints, triangle/vertex counts, bounds, texture dimensions, and file sizes. Two consecutive conversion runs on 2026-08-11 produced byte-identical GLBs, textures, and records.
