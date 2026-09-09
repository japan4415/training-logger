# /// script
# dependencies = ["numpy==2.4.3", "scipy==1.17.1"]
# ///
"""Reproduce translation registration and report independent reference residuals.
Run with uv run scripts/verify-bodyparts3d-registration.py /path/to/extracted/v3/obj.
Extract FMA13336/13337,32551/32552,45874/45875,79979/79980 OBJ files from
 the official archive pinned in import-bodyparts3d-v3.mjs. No output files change.
Distances are nearest vertices, not clinical alignment accuracy or surface distance.
"""
import gzip
import json
import sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

root = Path(__file__).resolve().parents[1]
atlas = json.loads((root / "public/models/human-atlas/atlas.json").read_text())
binary = gzip.decompress((root / "public/models/human-atlas/muscles.bin.gz").read_bytes())
source_dir = Path(sys.argv[1])
pairs = [("FMA13336", "FJ1452"), ("FMA13337", "FJ1452M"),
         ("FMA32551", "FJ1507"), ("FMA32552", "FJ1507M"),
         ("FMA45874", "FJ1446"), ("FMA45875", "FJ1446M"),
         ("FMA79979", "FJ1464"), ("FMA79980", "FJ1464M")]
meshes = []
for source_id, target_id in pairs:
    part = next(p for p in atlas["parts"] if p["id"] == target_id)
    vertices = np.array([[float(v) for v in line.split()[1:]]
                         for line in (source_dir / f"{source_id}.obj").read_text().splitlines()
                         if line.startswith("v ")])
    vertices = vertices[:, [0, 2, 1]] * [.001, .001, -.001] + [0, .0781112, -.1]
    target = np.frombuffer(binary, dtype="<f4", count=part["vertexCount"] * 3,
                           offset=part["positions"]).reshape(-1, 3).astype(float)
    meshes.append((vertices, target))
source = np.concatenate([m[0] for m in meshes[:2]])
target = np.concatenate([m[1] for m in meshes[:2]])
tree = cKDTree(target)
shift = np.zeros(3)
for _ in range(50):
    _, indices = tree.query(source + shift)
    delta = np.mean(target[indices] - source - shift, axis=0)
    shift += delta
    if np.linalg.norm(delta) < 1e-8:
        break
print(json.dumps({"translationMeters": shift.tolist()}))
for (source_id, target_id), (vertices, target) in zip(pairs, meshes):
    metrics = {}
    for label, translation in [("before", np.zeros(3)), ("after", shift)]:
        distances = cKDTree(target).query(vertices + translation)[0] * 1000
        metrics[label] = {"rmsMm": float(np.sqrt(np.mean(distances ** 2))),
                          "p95Mm": float(np.percentile(distances, 95))}
    print(json.dumps({"source": source_id, "target": target_id, **metrics}))
