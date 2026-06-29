import React, { useCallback, useRef, useState } from "react";

// In dev, Vite proxies /api -> http://localhost:8000 (see vite.config.js).
const API = "/api";

const STAT_FIELDS = [
  ["n_charts", "Islands", (v) => v],
  ["flipped_triangles", "Flipped tris", (v) => v],
  ["mean_angle_distortion", "Angle dist.", (v) => v.toFixed(3)],
  ["mean_area_distortion", "Area dist.", (v) => v.toFixed(3)],
  ["fill_ratio", "Atlas fill", (v) => (v * 100).toFixed(0) + "%"],
  ["time_seconds", "Time", (v) => v.toFixed(1) + "s"],
];

function download(dataUrl, name) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function App() {
  const [file, setFile] = useState(null);
  const [islandFaces, setIslandFaces] = useState(80);
  const [cone, setCone] = useState(55);
  const [refine, setRefine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // {stage, overall}
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const pick = (f) => {
    if (!f) return;
    setFile(f);
    setResult(null);
    setError(null);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  }, []);

  const STAGE_LABEL = {
    weld: "Repairing topology",
    segment: "Cutting seams",
    refine: "Merging islands",
    parameterize: "Flattening (LSCM + ARAP)",
    encode: "Packing atlas",
  };

  const run = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "weld", overall: 0 });
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("island_faces", String(islandFaces));
      body.append("cone", String(cone));
      body.append("refine", String(refine));
      const res = await fetch(`${API}/unwrap_stream`, { method: "POST", body });
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || `Unwrap failed (${res.status}).`);
      }
      // Read the newline-delimited JSON event stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const lineStr = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!lineStr) continue;
          const ev = JSON.parse(lineStr);
          if (ev.type === "progress") {
            setProgress({ stage: ev.stage, overall: ev.overall });
          } else if (ev.type === "error") {
            throw new Error(ev.detail);
          } else if (ev.type === "result") {
            setResult(ev);
            finished = true;
          }
        }
      }
    } catch (err) {
      // The server might just be offline — say so and how to fix it.
      const offline = err.message.includes("Failed to fetch");
      setError(
        offline
          ? "Can't reach the AutoUV server. Start it with `uvicorn server.app:app --port 8000`."
          : err.message
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stats = result?.stats;

  return (
    <div className="page">
      <div className="reg reg-tl" />
      <div className="reg reg-tr" />
      <div className="reg reg-bl" />
      <div className="reg reg-br" />

      <header className="masthead">
        <div className="wordmark">
          AUTO<span>UV</span>
        </div>
        <p className="thesis">
          Flatten a mesh into a handful of clean, low-distortion islands —
          not the hundred-shard confetti a default atlaser leaves behind.
        </p>
      </header>

      <main className="sheet">
        <div className="sheet-edge sheet-edge-x" aria-hidden />
        <div className="sheet-edge sheet-edge-y" aria-hidden />

        {!result && (
          <section
            className={`dropzone${dragging ? " is-dragging" : ""}${
              file ? " has-file" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".glb,.gltf,.obj,.ply,.stl"
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
            {file ? (
              <>
                <div className="drop-glyph" aria-hidden>
                  ◆
                </div>
                <div className="drop-title">{file.name}</div>
                <div className="drop-sub">
                  {(file.size / 1024).toFixed(0)} KB · ready to unwrap
                </div>
              </>
            ) : (
              <>
                <div className="drop-glyph" aria-hidden>
                  ⊹
                </div>
                <div className="drop-title">Drop a mesh here</div>
                <div className="drop-sub">
                  .glb · .gltf · .obj · .ply · .stl — or click to browse
                </div>
              </>
            )}
          </section>
        )}

        {result && (
          <section className="result">
            <figure className="preview">
              <img
                src={`data:image/png;base64,${result.preview_png}`}
                alt="UV atlas layout: colored islands packed into the unit square"
              />
              <figcaption>UV atlas — one colour per island</figcaption>
            </figure>

            <aside className="readout">
              <h2 className="readout-title">{file?.name}</h2>
              <dl className="stat-grid">
                {STAT_FIELDS.map(([key, label, fmt]) => (
                  <div className="stat" key={key}>
                    <dt>{label}</dt>
                    <dd
                      className={
                        key === "flipped_triangles" && stats[key] === 0
                          ? "good"
                          : undefined
                      }
                    >
                      {fmt(stats[key])}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="downloads">
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    download(
                      `data:model/gltf-binary;base64,${result.glb}`,
                      result.filename
                    )
                  }
                >
                  Download UV’d GLB
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    download(
                      `data:image/png;base64,${result.preview_png}`,
                      result.filename.replace(/\.glb$/, "_layout.png")
                    )
                  }
                >
                  Save layout PNG
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setResult(null);
                    setFile(null);
                  }}
                >
                  Unwrap another
                </button>
              </div>
            </aside>
          </section>
        )}
      </main>

      <section className="controls">
        <div className="control">
          <label htmlFor="island">
            Island size
            <span className="control-val">{islandFaces} faces</span>
          </label>
          <input
            id="island"
            type="range"
            min="20"
            max="200"
            step="10"
            value={islandFaces}
            onChange={(e) => setIslandFaces(+e.target.value)}
          />
          <p className="control-hint">
            Larger merges more aggressively — fewer, bigger islands.
          </p>
        </div>

        <div className="control">
          <label htmlFor="cone">
            Curvature cap
            <span className="control-val">{cone}°</span>
          </label>
          <input
            id="cone"
            type="range"
            min="30"
            max="80"
            step="5"
            value={cone}
            onChange={(e) => setCone(+e.target.value)}
          />
          <p className="control-hint">
            How much a single island may bend before a seam is cut.
          </p>
        </div>

        <div className="control control-toggle">
          <button
            type="button"
            role="switch"
            aria-checked={refine}
            className={`toggle${refine ? " on" : ""}`}
            onClick={() => setRefine((v) => !v)}
          >
            <span className="knob" />
          </button>
          <div>
            <div className="toggle-label">Validated merge</div>
            <p className="control-hint">
              Slower, but collapses sliver islands without ever folding a UV.
            </p>
          </div>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="action-row">
        <button
          className="btn btn-primary btn-run"
          disabled={!file || busy}
          onClick={run}
        >
          {busy ? "Unwrapping…" : "Unwrap"}
        </button>
        {busy && progress && (
          <div className="progress" role="progressbar"
               aria-valuenow={Math.round(progress.overall * 100)}
               aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-track">
              <div className="progress-fill"
                   style={{ width: `${Math.round(progress.overall * 100)}%` }} />
            </div>
            <span className="progress-label">
              {STAGE_LABEL[progress.stage] || progress.stage}…{" "}
              {Math.round(progress.overall * 100)}%
            </span>
          </div>
        )}
      </div>

      <footer className="foot">
        <span>AutoUV</span>
        <span className="seam" aria-hidden />
        <span>one core · Python CLI &amp; React, same unwrap</span>
      </footer>
    </div>
  );
}
