"""FastAPI bridge for AutoUV.

This is the thin web layer: it does no geometry work of its own, it just calls
the very same :func:`autouv.unwrap` that the Python CLI calls. That is the whole
point of the project layout -- one core, two front ends (a Python script / CLI
and a React web app).

Run it with::

    pip install -r server/requirements.txt
    uvicorn server.app:app --reload --port 8000

Then start the React app in ``web/`` (``npm install && npm run dev``); it talks
to this server at ``http://localhost:8000``.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from autouv import load, save_glb, render_uv, __version__
from autouv.unwrap import unwrap

app = FastAPI(title="AutoUV", version=__version__)

# the React dev server runs on a different origin, so allow it through
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten to your front-end origin in production
    allow_methods=["*"],
    allow_headers=["*"],
)

_ALLOWED = {".glb", ".gltf", ".obj", ".ply", ".stl"}
_MAX_FACES = 200_000              # guard against accidental huge uploads


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}


@app.post("/unwrap")
async def unwrap_endpoint(
    file: UploadFile = File(...),
    cone: float = Form(55.0),
    island_faces: int = Form(80),
    refine: bool = Form(True),
    resolution: int = Form(1024),
):
    """Unwrap an uploaded mesh and return stats + UV'd GLB + a preview PNG."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED:
        raise HTTPException(400, f"unsupported file type '{ext}'. "
                                 f"Use one of: {', '.join(sorted(_ALLOWED))}")

    data = await file.read()
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "input" + ext)
        with open(in_path, "wb") as fh:
            fh.write(data)

        try:
            mesh = load(in_path)
        except Exception as exc:                       # noqa: BLE001
            raise HTTPException(400, f"could not read mesh: {exc}")

        if mesh.n_faces == 0:
            raise HTTPException(400, "mesh has no faces")
        if mesh.n_faces > _MAX_FACES:
            raise HTTPException(413, f"mesh has {mesh.n_faces} faces; the limit "
                                     f"is {_MAX_FACES}")

        result = unwrap(
            mesh,
            max_cone_deg=cone,
            refine=refine,
            refine_target_faces=island_faces,
            resolution=resolution,
        )

        glb_path = os.path.join(tmp, "out.glb")
        png_path = os.path.join(tmp, "layout.png")
        save_glb(glb_path, result.vertices, result.faces, result.uv)
        render_uv(result, png_path)

        with open(glb_path, "rb") as fh:
            glb_b64 = base64.b64encode(fh.read()).decode("ascii")
        with open(png_path, "rb") as fh:
            png_b64 = base64.b64encode(fh.read()).decode("ascii")

    base_name = os.path.splitext(os.path.basename(file.filename or "mesh"))[0]
    return {
        "stats": result.stats,
        "glb": glb_b64,
        "preview_png": png_b64,
        "filename": f"{base_name}_uv.glb",
    }


# --------------------------------------------------------------------------
# Streaming variant: same unwrap, but pushes progress events so the web app can
# show a live bar. unwrap() is CPU-bound and synchronous, so it runs in a worker
# thread; its progress callback (fired from that thread) hands events to the
# event loop through a thread-safe queue, which the generator drains as
# newline-delimited JSON. The final line carries the full result payload.
# --------------------------------------------------------------------------

# fraction of the whole job each stage occupies, for one smooth 0-100% bar
_STAGE_PLAN = [("weld", 0.05), ("segment", 0.10),
               ("refine", 0.55), ("parameterize", 0.30)]
_STAGE_OFFSET = {}
_acc = 0.0
for _name, _w in _STAGE_PLAN:
    _STAGE_OFFSET[_name] = (_acc, _w)
    _acc += _w


def _overall(stage, frac):
    off, w = _STAGE_OFFSET.get(stage, (0.0, 0.0))
    return min(1.0, off + w * max(0.0, min(1.0, frac)))


def _encode_result(result, tmp, base_name):
    glb_path = os.path.join(tmp, "out.glb")
    png_path = os.path.join(tmp, "layout.png")
    save_glb(glb_path, result.vertices, result.faces, result.uv)
    render_uv(result, png_path)
    with open(glb_path, "rb") as fh:
        glb_b64 = base64.b64encode(fh.read()).decode("ascii")
    with open(png_path, "rb") as fh:
        png_b64 = base64.b64encode(fh.read()).decode("ascii")
    return {
        "stats": result.stats,
        "glb": glb_b64,
        "preview_png": png_b64,
        "filename": f"{base_name}_uv.glb",
    }


@app.post("/unwrap_stream")
async def unwrap_stream(
    file: UploadFile = File(...),
    cone: float = Form(55.0),
    island_faces: int = Form(80),
    refine: bool = Form(True),
    resolution: int = Form(1024),
):
    """Unwrap with live progress. Returns newline-delimited JSON events:

        {"type":"progress","stage":..,"frac":..,"overall":..}
        {"type":"result",  "stats":..,"glb":..,"preview_png":..,"filename":..}
        {"type":"error",   "detail":..}
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED:
        raise HTTPException(400, f"unsupported file type '{ext}'. "
                                 f"Use one of: {', '.join(sorted(_ALLOWED))}")
    data = await file.read()
    base_name = os.path.splitext(os.path.basename(file.filename or "mesh"))[0]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    async def gen():
        def line(obj):
            return json.dumps(obj) + "\n"

        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "input" + ext)
            with open(in_path, "wb") as fh:
                fh.write(data)
            try:
                mesh = load(in_path)
            except Exception as exc:                       # noqa: BLE001
                yield line({"type": "error", "detail": f"could not read mesh: {exc}"})
                return
            if mesh.n_faces == 0:
                yield line({"type": "error", "detail": "mesh has no faces"})
                return
            if mesh.n_faces > _MAX_FACES:
                yield line({"type": "error",
                            "detail": f"mesh has {mesh.n_faces} faces; the limit "
                                      f"is {_MAX_FACES}"})
                return

            def cb(stage, frac):
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    {"type": "progress", "stage": stage, "frac": frac,
                     "overall": _overall(stage, frac)})

            def work():
                return unwrap(
                    mesh,
                    max_cone_deg=cone,
                    refine=refine,
                    refine_target_faces=island_faces,
                    resolution=resolution,
                    progress=cb,
                    verbose=False,
                )

            task = asyncio.create_task(asyncio.to_thread(work))
            while not (task.done() and queue.empty()):
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=0.2)
                    yield line(ev)
                except asyncio.TimeoutError:
                    pass
            try:
                result = task.result()
            except Exception as exc:                       # noqa: BLE001
                yield line({"type": "error", "detail": f"unwrap failed: {exc}"})
                return
            yield line({"type": "progress", "stage": "encode",
                        "frac": 1.0, "overall": 1.0})
            payload = _encode_result(result, tmp, base_name)
            payload["type"] = "result"
            yield line(payload)

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
