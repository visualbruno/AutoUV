# AutoUV

Automatic UV unwrapping aimed at **low-poly meshes** (game props, kit-bash
pieces, scanned/retopo'd organic shapes up to ~50k faces). The goal is the
opposite of what a fast atlaser like xatlas does by default: instead of a
hundred small shards, produce **a handful of large, clean, low-distortion
islands** — the kind a human would cut by hand.

One geometry core, two front ends:

- a **Python library + CLI** (`autouv …`), and
- a **React web app** that talks to a thin **FastAPI** server.

Both call the exact same `autouv.unwrap`.

## Result on a 10k-face cave mesh

| metric | xatlas (default) | AutoUV |
| --- | --- | --- |
| islands | hundreds of shards | ~90 large islands |
| flipped triangles | — | 0 |
| angle distortion | — | 1.016 (1.0 = conformal) |
| atlas fill | — | ~80% |
| time | ~instant | ~12 s |

`uv_layout.png` shows the packed atlas: a few dominant islands (the cave
walls) plus a small tail, all axis-aligned and tightly packed.

## Why it looks better (the low-poly-specific ideas)

A UV unwrap is judged on four things; AutoUV targets each one directly.

0. **Few charts → topology repair first.** The hard floor on chart count is the
   number of *connected components*: a chart grows along shared edges, so it can
   never span two disconnected shells. Meshes from scans and AI generators
   (Tripo/Meshy/Rodin) are routinely shattered into hundreds of shells whose
   seams are lined with vertices that are coincident in space but never welded —
   so a surface that should be one sheet is split into 600–800 components, and
   *any* unwrapper is forced to emit one chart per component. AutoUV welds by
   true distance (KD-tree + union-find, tolerance = a fraction of the median
   edge) before segmenting. On the BabyRaptor sample this takes **810 components
   → 3**, and so **810 charts → ~90** at the same distortion; on already-clean
   meshes it is a no-op (Cave 4→4, Church 2→2). trimesh's grid-snapping
   `merge_vertices` misses these pairs, which is why the shells survive a normal
   load.

1. **Few seams → bounded-curvature segmentation.** Charts are grown by greedy
   agglomerative merging under an **exact normal-cone** constraint: a face
   joins a chart only while the chart's normal cone half-angle stays under a
   cap. Bounding the normal cone bounds curvature, which bounds flattening
   distortion — so the single `max_cone_deg` dial trades island count against
   distortion in a predictable way. (The cone is tracked exactly, not via the
   compounding upper bound that makes naive versions over-fragment.)

2. **No sliver confetti → an LSCM-validated merge pass.** The cone test is a
   conservative *proxy*; on noisy organic meshes it leaves a long tail of tiny
   charts that could in fact be flattened together. The refinement pass merges
   adjacent charts whenever the union **actually parameterises flip-free** and
   below a distortion threshold, with a compactness guard so it never creates
   spindly islands. This is what collapses ~330 raw charts to ~90 without
   introducing a single UV overlap.

3. **Low distortion → LSCM seed, ARAP finish, planar fallback.** Each chart is
   flattened with Least-Squares Conformal Maps (angle-preserving), then refined
   with an **as-rigid-as-possible** (ARAP) local/global solver that pulls back
   the *area* distortion conformal maps leave on larger islands; near-flat or
   closed charts fall back to mean-normal planar projection. The lowest combined
   (angle + area), flip-free result is kept per chart. On BabyRaptor, ARAP takes
   the area distortion from ~0.84 to ~0.09 and the flip count to 0 while leaving
   angle distortion unchanged.

4. **Tight, bleed-safe atlas → align + skyline pack.** Each island is
   PCA-aligned to its dominant axis (rectangular islands pack better), given
   uniform texel density, and placed with a skyline bottom-left packer (with
   90° rotation). Padding is specified in texels for a target resolution, which
   prevents mip/bilinear bleed at low texture sizes.

## Install

```bash
pip install -r requirements.txt        # or: pip install -e .
```

## Use it from Python

```python
import autouv

mesh = autouv.load("model.glb")
result = autouv.unwrap(mesh, max_cone_deg=55, refine_target_faces=80)

print(result.stats)                    # islands, flips, distortion, fill, timing
autouv.save_glb("model_uv.glb", result.vertices, result.faces, result.uv)
autouv.render_uv(result, "uv_layout.png")
```

`result.uv` is an `(n_vertices, 2)` array in `[0, 1]`; `result.vertices` /
`result.faces` are the matching seam-split geometry. See
`examples/unwrap_example.py`.

## Use it from the command line

```bash
autouv unwrap model.glb -o model_uv.glb --preview uv_layout.png
autouv unwrap model.glb -o out.glb --cone 60 --island-faces 120   # fewer islands
autouv unwrap model.glb -o out.glb --no-refine                    # faster, coarser
```

(or `python -m autouv unwrap …` without installing.)

## Use it from the web app

Terminal 1 — the API:

```bash
pip install -r server/requirements.txt
uvicorn server.app:app --reload --port 8000
```

Terminal 2 — the React front end:

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxies /api to the server
```

Drop a `.glb`/`.gltf`/`.obj`/`.ply`/`.stl` on the page, tune island size and
curvature cap, and download the UV'd GLB or the layout PNG. The server simply
forwards to `autouv.unwrap` and returns the stats, the GLB, and a preview.

## Key parameters

| parameter | default | effect |
| --- | --- | --- |
| `weld` | True | topology repair: weld coincident-but-unshared vertices so disconnected shells reconnect (off = preserve exact vertex set) |
| `weld_tol_frac` | 0.1 | weld tolerance as a fraction of the median edge length; vertices closer than this merge |
| `max_cone_deg` | 55 | curvature cap per island; higher → fewer, more distorted islands |
| `refine` | True | run the validated-merge pass (off = faster, more islands) |
| `refine_target_faces` | 80 | charts below this size are merge candidates; higher → larger islands |
| `arap_iters` | 4 | ARAP flattening iterations per chart; 0 = LSCM/planar only (purely conformal) |
| `resolution` | 1024 | target texture size used to size the inter-island padding |
| `padding_texels` | 4 | gap between islands, in texels at that resolution |

## Layout

```
autouv/          core library  (mesh, segment, param, postprocess, pack, io, unwrap, render) + CLI
server/app.py    FastAPI bridge -> autouv.unwrap
web/             Vite + React front end
examples/        minimal Python script
```

## Limitations / notes

- LSCM is conformal (preserves angles, lets **area**/texel-density drift on
  curved islands); the ARAP refinement pass now corrects most of that. Set
  `--arap-iters 0` to fall back to the old LSCM/planar behaviour if you want a
  purely conformal map.
- The validated-merge pass runs many small linear solves; expect roughly linear
  growth with face count (a ~50k mesh is tens of seconds). Use `--no-refine`
  for an interactive-speed result.
- Input meshes are welded on load; very fragmented or non-manifold inputs still
  work but may need more islands.
```
