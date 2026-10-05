"""Read-only region API for the VGP browser; run with --help for configuration."""
from __future__ import annotations

import argparse
import csv
import functools
import gzip
import json
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
import uvicorn

HERE = Path(__file__).resolve().parent
LOG = logging.getLogger("vgp.browser")
DATASETS = ("raw", "filter", "cmaes", "cmaes_sc")
FEATURE_TYPES = {"gene", "pseudogene", "mRNA", "transcript", "exon", "CDS", "lnc_RNA", "ncRNA", "tRNA", "rRNA"}


class Window(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accession: str
    seq: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    dataset: Literal["raw", "filter", "cmaes", "cmaes_sc"] = "cmaes"
    mode: Literal["free", "anchor"] = "free"
    windows: list[Window] = Field(min_length=1, max_length=16)
    targets: list[str] = Field(default_factory=list, max_length=15)
    min_identity: float = Field(default=0, ge=0, le=1)
    min_length: int = Field(default=0, ge=0)
    direction: Literal["preferred", "both"] = "preferred"


def signature(path: Path) -> str:
    stat = path.stat()
    return f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"


def read_attributes(raw: str) -> dict[str, str]:
    # Split before percent-decoding: escaped semicolons are literal values.
    return {unquote(k): unquote(v) for item in raw.split(";") if "=" in item
            for k, v in [item.split("=", 1)]}


class Store:
    def __init__(self, root: Path, cache: Path, impg: Path, heatmap_file: Path | None = None) -> None:
        self.root, self.cache, self.impg = root.resolve(), cache.resolve(), impg.resolve()
        if not self.impg.is_file():
            raise RuntimeError(f"Program impg failed with: executable not found: {self.impg}")
        self.cache.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.workers = threading.BoundedSemaphore(2)
        self.catalog: dict[str, dict[str, Any]] = {}
        with (self.root / "gff_index.tsv").open() as handle:
            self.gff = {r["accession"]: r for r in csv.DictReader(handle, delimiter="\t")}
        meta_path = self.root / "depth_hist/meta/genomes.tsv"
        with meta_path.open() as handle:
            self.mapping_meta = {r["accession"]: r for r in csv.DictReader(handle, delimiter="\t")}
        with (heatmap_file or HERE / "heatmap_data.json").open() as handle:
            heatmap = json.load(handle)
        main = set((self.root / "genome/1.list").read_text().split())
        for i, name in enumerate(heatmap["leafOrder"]):
            aliases = heatmap["speciesToAcc"].get(name, heatmap["speciesToAcc"].get(name.rstrip("_"), []))
            acc = next((a for a in aliases if a in main), None)
            if acc is None:
                raise RuntimeError(f"No local assembly accession for heatmap sample {name}")
            gff = self.gff.get(acc, {})
            self.catalog[acc] = {
                "accession": acc, "aliases": aliases, "name": name.rstrip("_").replace("_", " "),
                "common": heatmap["commonNames"][i],
                "clade": heatmap["cladeNames"][heatmap["speciesCladeIdx"][i]],
                "annotation": "available" if gff.get("usable") == "yes" else "unavailable",
                "annotation_status": gff.get("status", "NOT_FOUND"),
                "annotation_accession": gff.get("gff_dir", ""),
                "annotation_bp_fraction": gff.get("gff_bp_frac", ""),
            }
        self.seqmaps: dict[str, dict[str, str]] | None = None

    def require_accession(self, acc: str) -> None:
        if acc not in self.catalog:
            raise HTTPException(422, f"Unknown assembly accession: {acc}")

    @functools.lru_cache(maxsize=600)
    def contigs(self, acc: str) -> dict[str, int]:
        self.require_accession(acc)
        paths = [self.root / "genome" / acc / f"{acc}.fna.gz.fai",
                 self.root / "genome" / f"{acc}.fna.gz.fai"]
        path = next((p for p in paths if p.is_file()), None)
        if path is None:
            raise HTTPException(404, f"Assembly sequence index NOT_FOUND for {acc}")
        with path.open() as handle:
            return {f[0]: int(f[1]) for line in handle for f in [line.rstrip().split("\t")]}

    def validate_window(self, window: Window) -> None:
        contigs = self.contigs(window.accession)
        if window.seq not in contigs:
            raise HTTPException(422, f"Unknown sequence {window.seq} in {window.accession}")
        if not window.start < window.end <= contigs[window.seq]:
            raise HTTPException(422, f"Invalid interval: require 0 <= start < end <= {contigs[window.seq]}")

    def annotation_map(self, acc: str) -> dict[str, str]:
        """Reuse measured seqmaps only when the annotation file is unchanged."""
        with self.lock:
            if self.seqmaps is None:
                self.seqmaps = {}
                path = self.root / "depth_hist/meta/seqmap581.tsv"
                with path.open() as handle:
                    for row in csv.DictReader(handle, delimiter="\t"):
                        if row["gff_seqid"]:
                            self.seqmaps.setdefault(row["accession"], {})[row["depth_name"]] = row["gff_seqid"]
            current = self.gff[acc]
            prior = self.mapping_meta.get(acc, {})
            if current["gff_path"] != prior.get("gff_path"):
                # No inferred aliases from a different annotation version.
                return {}
            return self.seqmaps.get(acc, {})

    def annotation_db(self, acc: str) -> Path:
        row = self.gff[acc]
        source = Path(row["gff_path"])
        if not source.is_file():
            raise HTTPException(503, f"Annotation file NOT_FOUND: {source}")
        db = self.cache / f"{acc}.annotation.sqlite"
        fingerprint = signature(source)
        with self.lock:
            if db.is_file():
                with sqlite3.connect(db) as conn:
                    if conn.execute("SELECT value FROM metadata WHERE key='source'").fetchone() == (fingerprint,):
                        return db
            # Atomic cache replacement. Source annotation is always read-only.
            with tempfile.NamedTemporaryFile(dir=self.cache, suffix=".sqlite", delete=False) as temp:
                tmp = Path(temp.name)
            try:
                with sqlite3.connect(tmp) as conn:
                    conn.executescript("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);"
                                       "CREATE TABLE features(id INTEGER PRIMARY KEY,seq TEXT,start INTEGER,end INTEGER,"
                                       "kind TEXT,strand TEXT,name TEXT,feature_id TEXT,parent TEXT);"
                                       "CREATE VIRTUAL TABLE intervals USING rtree_i32(id,start,end);")
                    opener = gzip.open if source.suffix == ".gz" else open
                    batch: list[tuple[Any, ...]] = []
                    feature_id = 0
                    def flush() -> None:
                        conn.executemany("INSERT INTO features VALUES(?,?,?,?,?,?,?,?,?)", batch)
                        conn.executemany("INSERT INTO intervals VALUES(?,?,?)", [(r[0], r[2], r[3]) for r in batch])
                        batch.clear()
                    with opener(source, "rt") as handle:
                        for line_no, line in enumerate(handle, 1):
                            if line.startswith("##FASTA"):
                                break
                            if line.startswith("#") or not line.strip():
                                continue
                            f = line.rstrip().split("\t")
                            if len(f) != 9:
                                raise RuntimeError(f"Invalid GFF at {source}:{line_no}: expected 9 columns")
                            if f[2] not in FEATURE_TYPES:
                                continue
                            start, end = int(f[3]) - 1, int(f[4])
                            if not 0 <= start < end <= 2147483647:
                                raise RuntimeError(f"Invalid GFF coordinates at {source}:{line_no}")
                            attrs = read_attributes(f[8])
                            feature_id += 1
                            batch.append((feature_id, f[0], start, end, f[2], f[6],
                                          attrs.get("Name", attrs.get("gene", attrs.get("ID", ""))),
                                          attrs.get("ID", ""), attrs.get("Parent", "")))
                            if len(batch) >= 10000:
                                flush()
                    flush()
                    conn.execute("CREATE INDEX by_sequence ON features(seq)")
                    conn.execute("INSERT INTO metadata VALUES('source',?)", (fingerprint,))
                os.replace(tmp, db)
            finally:
                tmp.unlink(missing_ok=True)
        return db

    def annotations(self, window: Window) -> dict[str, Any]:
        row = self.gff.get(window.accession, {})
        info: dict[str, Any] = {"status": "unavailable", "features": [], "total": 0,
                                "source_status": row.get("status", "NOT_FOUND"),
                                "annotation_accession": row.get("gff_dir", ""), "truncated": False}
        if row.get("usable") != "yes":
            return info
        db = self.annotation_db(window.accession)
        mapped = self.annotation_map(window.accession).get(window.seq)
        bare = window.seq.split("#", 2)[-1]
        with sqlite3.connect(db) as conn:
            if mapped is None:
                # Exact seqid is the only fallback; do not guess by rank or length.
                if conn.execute("SELECT 1 FROM features WHERE seq=? LIMIT 1", (bare,)).fetchone():
                    mapped = bare
                else:
                    info["status"] = "unmapped_sequence"
                    return info
            info["mapping"] = "exact_seqid" if mapped == bare else "project_validated_seqmap"
            info["gff_seqid"] = mapped
            params = (mapped, window.end, window.start)
            sql = "FROM features f JOIN intervals i ON f.id=i.id WHERE f.seq=? AND i.start<? AND i.end>?"
            total = conn.execute("SELECT count(*) " + sql, params).fetchone()[0]
            rows = conn.execute("SELECT f.seq,f.start,f.end,f.kind,f.strand,f.name,f.feature_id,f.parent " + sql +
                                " ORDER BY f.start,f.end LIMIT 5001", params).fetchall()
        info.update(status="available", total=total, truncated=total > 5000,
                    source=str(Path(row["gff_path"])),
                    features=[dict(zip(("seq", "start", "end", "kind", "strand", "name", "id", "parent"), r)) for r in rows[:5000]])
        return info

    def files(self, dataset: str, anchor: str, other: str, direction: str) -> list[Path]:
        folder = self.root / dataset
        candidates = [folder / f"{other}_vs_{anchor}.paf.gz", folder / f"{anchor}_vs_{other}.paf.gz"]
        found = [p for p in candidates if p.is_file()]
        return found if direction == "both" else found[:1]

    @functools.lru_cache(maxsize=128)
    def query_file(self, file: str, fingerprint: str, index_fingerprint: str,
                   seq: str, start: int, end: int) -> tuple[dict[str, Any], ...]:
        source = Path(file)
        index = Path(file + ".impg")
        copied = self.cache / (source.parent.name + "-" + index.name)
        stamp = copied.with_suffix(copied.suffix + ".source")
        with self.lock:
            if not copied.exists() or not stamp.exists() or stamp.read_text() != index_fingerprint:
                with tempfile.NamedTemporaryFile(dir=self.cache, delete=False) as temp:
                    tmp = Path(temp.name)
                try:
                    if index_fingerprint.startswith("GENERATE:"):
                        build_command = [str(self.impg), "index", "-a", str(source), "-i", str(tmp),
                                         "--force-reindex", "-t", "1", "-v", "0"]
                        try:
                            with self.workers:
                                built = subprocess.run(build_command, capture_output=True, text=True,
                                                       timeout=120, cwd=self.cache)
                        except subprocess.TimeoutExpired as error:
                            raise HTTPException(504, "Program impg failed with: cache index creation exceeded 120 seconds") from error
                        if built.returncode:
                            raise HTTPException(503, f"Program impg failed with: {built.stderr.strip()}")
                        LOG.info("cache index command=%s", json.dumps(build_command))
                    else:
                        shutil.copyfile(index, tmp)
                    os.replace(tmp, copied)
                    stamp.write_text(index_fingerprint)
                finally:
                    tmp.unlink(missing_ok=True)
        command = [str(self.impg), "query", "-a", str(source), "-i", str(copied),
                   "-r", f"{seq}:{start}-{end}", "--no-merge", "--min-transitive-len", "1",
                   "-o", "paf", "-t", "1", "-v", "0"]
        before = time.monotonic()
        try:
            with self.workers:
                result = subprocess.run(command, capture_output=True, text=True, timeout=120, cwd=self.cache)
        except subprocess.TimeoutExpired as error:
            raise HTTPException(504, "Program impg failed with: query exceeded 120 seconds; narrow the interval") from error
        if result.returncode:
            raise HTTPException(503, f"Program impg failed with: {result.stderr.strip()}")
        LOG.info("query command=%s elapsed=%.3fs", json.dumps(command), time.monotonic() - before)
        blocks: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            f = line.split("\t")
            if len(f) < 12:
                raise RuntimeError("Program impg failed with: malformed PAF output")
            tags = {k: value for tag in f[12:] for k, _, value in [tag.split(":", 2)]}
            qseq, tseq = f[0], f[5]
            q0, q1, t0, t1 = int(f[2]), int(f[3]), int(f[7]), int(f[8])
            strand = f[4]
            cigar = tags.get("cg", "")
            # Returned PAF is the CIGAR-based interval projection, not a raw full-genome record.
            # Normalize the anchor to target while retaining original-file provenance.
            if tseq != seq and qseq == seq:
                qseq, tseq, q0, q1, t0, t1 = tseq, qseq, t0, t1, q0, q1
                cigar = ""  # Original output CIGAR orientation would be misleading after swapping.
            if tseq != seq:
                raise RuntimeError("Program impg failed with: output does not contain the requested anchor")
            blocks.append({"query_seq": qseq, "query_start": q0, "query_end": q1,
                           "target_seq": tseq, "target_start": t0, "target_end": t1,
                           "strand": strand, "matches": int(f[9]), "alignment_length": int(f[10]),
                           "identity": float(tags.get("bi", int(f[9]) / int(f[10]) if int(f[10]) else 0)),
                           "gap_compressed_identity": float(tags["gi"]) if "gi" in tags else None,
                           "mapq": None if f[11] == "255" else int(f[11]), "cigar": cigar,
                           "source": str(source), "source_direction": source.name.removesuffix(".paf.gz"),
                           "provenance": "direct_alignment_interval_projection"})
        return tuple(blocks)

    def pair(self, dataset: str, anchor: Window, other: str, direction: str) -> dict[str, Any]:
        self.require_accession(other)
        files = self.files(dataset, anchor.accession, other, direction)
        if not files:
            return {"status": "missing_file", "blocks": [], "anchor": anchor.accession,
                    "other": other, "message": "No local PAF for this pair/dataset"}
        blocks: list[dict[str, Any]] = []
        for path in files:
            index = Path(str(path) + ".impg")
            file_signature = signature(path)
            # Missing or stale source indices are repaired only inside the disposable cache.
            index_signature = signature(index) if index.is_file() and index.stat().st_mtime_ns >= path.stat().st_mtime_ns else "GENERATE:" + file_signature
            blocks.extend(self.query_file(str(path), file_signature, index_signature, anchor.seq, anchor.start, anchor.end))
        return {"status": "available", "blocks": blocks, "anchor": anchor.accession,
                "other": other, "sources": [str(p) for p in files]}

    def query(self, request: Query) -> dict[str, Any]:
        for window in request.windows:
            self.validate_window(window)
        for acc in request.targets:
            self.require_accession(acc)
        if request.mode == "anchor" and (len(request.windows) != 1 or not request.targets):
            raise HTTPException(422, "Anchor mode requires one window and at least one target assembly")
        if request.mode == "free" and len(request.windows) < 2:
            raise HTTPException(422, "Free mode requires at least two windows")
        before = time.monotonic()
        windows = list(request.windows)
        blocks: list[dict[str, Any]] = []
        pairs: list[dict[str, Any]] = []
        def selected(block: dict[str, Any]) -> bool:
            return bool(block["identity"] >= request.min_identity and block["alignment_length"] >= request.min_length)
        if request.mode == "anchor":
            anchor = windows[0]
            for acc in dict.fromkeys(request.targets):
                if acc == anchor.accession:
                    continue
                pair = self.pair(request.dataset, anchor, acc, request.direction)
                candidates = [b for b in pair.pop("blocks") if selected(b)]
                pair["count"] = len(candidates)
                pairs.append(pair)
                # Split loci across sequences and distant hits; never force a single ortholog.
                groups: dict[str, list[tuple[int, int]]] = {}
                for b in candidates:
                    groups.setdefault(b["query_seq"], []).append((b["query_start"], b["query_end"]))
                for seq, spans in groups.items():
                    merged: list[list[int]] = []
                    for start, end in sorted(spans):
                        if merged and start <= merged[-1][1] + 10000:
                            merged[-1][1] = max(merged[-1][1], end)
                        else:
                            merged.append([start, end])
                    for start, end in merged:
                        i = len(windows)
                        new_window = Window(accession=acc, seq=seq, start=start, end=end)
                        self.validate_window(new_window)
                        windows.append(new_window)
                        blocks.extend(dict(b, target_window=0, query_window=i) for b in candidates
                                      if b["query_seq"] == seq and b["query_start"] < end and b["query_end"] > start)
                if len(windows) > 64:
                    raise HTTPException(422, "More than 64 mapped loci; narrow the anchor or increase the filters")
        else:
            for i, anchor in enumerate(windows):
                for j in range(i + 1, len(windows)):
                    other = windows[j]
                    if anchor.accession == other.accession:
                        continue
                    pair = self.pair(request.dataset, anchor, other.accession, request.direction)
                    candidates = [b for b in pair.pop("blocks") if selected(b) and b["query_seq"] == other.seq
                                  and b["query_start"] < other.end and b["query_end"] > other.start]
                    pair.update(count=len(candidates), target_window=i, query_window=j)
                    pairs.append(pair)
                    blocks.extend(dict(b, target_window=i, query_window=j) for b in candidates)
        total = len(blocks)
        result_windows = [dict(w.model_dump(), length=self.contigs(w.accession)[w.seq],
                               name=self.catalog[w.accession]["name"], annotation=self.annotations(w)) for w in windows]
        return {"windows": result_windows, "blocks": blocks[:5000], "total_blocks": total,
                "truncated": total > 5000, "pairs": pairs, "elapsed_seconds": round(time.monotonic() - before, 3),
                "coordinate_system": "0-based half-open", "request": request.model_dump(),
                "anchor_locus_merge_gap": 10000 if request.mode == "anchor" else None,
                "identity_definition": "IMPG interval base identity (bi); MAPQ 255 means unavailable",
                "query_parameters": {"transitive": False, "merge": False, "min_transitive_len": 1},
                "dataset": request.dataset, "run_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def create_app(store: Store, allowed_origins: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="VGP comparative genome browser", version="0.1.0")
    app.add_middleware(CORSMiddleware,
                       allow_origins=allowed_origins or ["https://unavailable-2374.github.io"],
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type"])

    @app.exception_handler(RuntimeError)
    def runtime_error_handler(_: Any, error: RuntimeError) -> JSONResponse:
        LOG.exception("Required processing step failed", exc_info=error)
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @app.get("/api/catalog")
    def catalog() -> dict[str, Any]:
        return {"samples": list(store.catalog.values()), "datasets": list(DATASETS),
                "coordinate_system": "0-based half-open", "max_input_windows": 16,
                "backend": "local indexed PAF / IMPG", "version": "0.1.0"}

    @app.get("/api/contigs/{accession}")
    def contigs(accession: str) -> dict[str, Any]:
        return {"accession": accession, "contigs": [{"seq": s, "length": n} for s, n in
                sorted(store.contigs(accession).items(), key=lambda x: -x[1])]}

    @app.post("/api/query")
    def query(request: Query) -> dict[str, Any]:
        return store.query(request)

    @app.get("/")
    @app.get("/browser.html")
    def browser() -> FileResponse:
        return FileResponse(HERE / "browser.html")

    @app.get("/{asset}")
    def asset(asset: str) -> FileResponse:
        if asset not in {"browser.js", "browser.css", "index.html", "heatmap_data.json",
                         "downloads.js", "downloads.css", "download_catalog.json"}:
            raise HTTPException(404, "Not found")
        return FileResponse(HERE / asset)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=HERE.parent)
    parser.add_argument("--cache", type=Path, default=HERE / ".browser-cache")
    parser.add_argument("--impg", type=Path, default=Path(os.environ.get("VGP_IMPG", "/scratch/10779/shuocao2374/tool/impg/target/system/release/impg")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--allow-origin", action="append", default=["https://unavailable-2374.github.io"],
                        help="Allowed frontend origin for a separately hosted API (repeatable)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store(args.data_root, args.cache, args.impg)
    uvicorn.run(create_app(store, args.allow_origin), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
