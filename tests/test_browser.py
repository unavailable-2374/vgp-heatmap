"""Integration checks against REAL local VGP inputs. No simulated scientific data."""
from __future__ import annotations

import gzip
from pathlib import Path
import sys
import shutil
from typing import Any, Iterator

from fastapi.testclient import TestClient
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser_server import HERE, Query, Store, Window, create_app, read_attributes

ROOT = HERE.parent
IMPG = Path("/scratch/10779/shuocao2374/tool/impg/target/system/release/impg")
ANCHOR = "GCA_005190385.3"
OTHER = "GCA_003287225.2"
SEQ = "GCA_005190385.3#0#SIHG02000020.1"
SOURCE = ROOT / "cmaes" / f"{OTHER}_vs_{ANCHOR}.paf.gz"


@pytest.fixture(scope="session")
def store() -> Store:
    if not SOURCE.is_file() or not IMPG.is_file():
        pytest.skip("REAL local VGP PAF and IMPG required for integration tests")
    return Store(ROOT, HERE / ".browser-cache", IMPG)


@pytest.fixture
def client(store: Store) -> Iterator[TestClient]:
    with TestClient(create_app(store)) as connection:
        yield connection


def request() -> dict[str, Any]:
    return {"mode": "anchor", "windows": [{"accession": ANCHOR, "seq": SEQ,
             "start": 47260000, "end": 47282000}], "targets": [OTHER]}


def test_catalog_and_contigs(client: TestClient) -> None:
    result = client.get("/api/catalog")
    assert result.status_code == 200
    samples = result.json()["samples"]
    assert len(samples) == 581
    assert len({s["accession"] for s in samples}) == 581
    assert next(s for s in samples if s["accession"] == ANCHOR)["annotation_status"].startswith("REJECTED")
    contigs = client.get(f"/api/contigs/{ANCHOR}").json()["contigs"]
    assert next(c for c in contigs if c["seq"] == SEQ)["length"] == 138185303


def test_real_anchor_preserves_multiple_loci(client: TestClient) -> None:
    before = [(p.stat().st_size, p.stat().st_mtime_ns) for p in [SOURCE, Path(str(SOURCE)+".impg")]]
    response = client.post("/api/query", json=request())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["total_blocks"] == 6
    assert len(result["windows"]) >= 3  # Two query contigs, not one forced ortholog.
    assert {b["strand"] for b in result["blocks"]} == {"+", "-"}
    assert result["windows"][0]["annotation"]["status"] == "unavailable"
    for block in result["blocks"]:
        assert block["source"] == str(SOURCE)
        assert 0 <= block["identity"] <= 1
        assert block["mapq"] is None
        assert block["target_seq"] == SEQ
        assert 47260000 <= block["target_start"] < block["target_end"] <= 47282000
        assert block["matches"] <= block["alignment_length"]
    after = [(p.stat().st_size, p.stat().st_mtime_ns) for p in [SOURCE, Path(str(SOURCE)+".impg")]]
    assert before == after


def test_real_free_windows_and_identity_filter(client: TestClient) -> None:
    anchored = client.post("/api/query", json=request()).json()
    windows = [{k: w[k] for k in ("accession", "seq", "start", "end")} for w in anchored["windows"]]
    result = client.post("/api/query", json={"mode": "free", "windows": windows})
    assert result.status_code == 200, result.text
    assert result.json()["total_blocks"] == 6
    filtered = client.post("/api/query", json={"mode": "free", "windows": windows, "min_identity": 1.0})
    assert filtered.status_code == 200
    assert filtered.json()["total_blocks"] == 0


@pytest.mark.parametrize("changes", [
    {"start": -1}, {"start": 47282000}, {"end": 138185304},
    {"accession": "../../etc/passwd"}, {"seq": "unknown"}, {"start": "47260000"},
])
def test_invalid_regions_rejected(client: TestClient, changes: dict[str, Any]) -> None:
    body = request()
    body["windows"][0].update(changes)
    assert client.post("/api/query", json=body).status_code == 422


def test_reversed_window_uses_same_real_pair(client: TestClient) -> None:
    result = client.post("/api/query", json=request()).json()
    w = next(w for w in result["windows"] if w["seq"].endswith("POVN02000163.1"))
    reversed_request = {"mode": "anchor", "windows": [{k: w[k] for k in ("accession", "seq", "start", "end")}], "targets": [ANCHOR]}
    response = client.post("/api/query", json=reversed_request)
    assert response.status_code == 200, response.text
    assert response.json()["total_blocks"] >= 1
    assert all(b["target_seq"] == w["seq"] for b in response.json()["blocks"])


def test_exact_gene_coordinates_and_parent_ids(store: Store) -> None:
    acc = "GCA_008658365.1"  # REAL GFF with exact assembly sequence identifiers.
    path = Path(store.gff[acc]["gff_path"])
    contigs = store.contigs(acc)
    with path.open() as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            f = line.rstrip().split("\t")
            seq = next((s for s in contigs if s.split("#", 2)[-1] == f[0]), None)
            if f[2] == "gene" and seq is not None:
                break
        else:
            pytest.fail("No REAL gene with an exact mapped sequence found")
    attrs = read_attributes(f[8])
    w = Window(accession=acc, seq=seq, start=int(f[3])-1, end=int(f[4]))
    annotation = store.annotations(w)
    assert annotation["status"] == "available"
    gene = next(g for g in annotation["features"] if g["id"] == attrs["ID"])
    assert gene["start"] == int(f[3])-1 and gene["end"] == int(f[4])
    assert gene["strand"] == f[6]
    assert any(g["kind"] == "exon" and g["parent"] for g in annotation["features"])


def test_query_clipped_by_cigar(client: TestClient) -> None:
    body = request()
    body["windows"][0].update(start=47281000, end=47281100)
    result = client.post("/api/query", json=body)
    assert result.status_code == 200, result.text
    blocks = result.json()["blocks"]
    assert blocks
    assert all(47281000 <= b["target_start"] < b["target_end"] <= 47281100 for b in blocks)
    # The source full blocks span 307 bp; these are true 100 bp interval projections.
    assert all(b["target_end"] - b["target_start"] <= 100 for b in blocks)


def test_missing_pair_differs_from_zero_hits(store: Store) -> None:
    # Use a TEST-only absent directory. No fake PAF or results are generated.
    w = Window(accession=ANCHOR, seq=SEQ, start=47260000, end=47282000)
    assert store.pair("TEST_NOT_A_DATASET", w, OTHER, "preferred")["status"] == "missing_file"
    assert store.pair("cmaes", Window(accession=ANCHOR, seq=SEQ, start=0, end=1), OTHER, "preferred")["status"] == "available"


def test_assets_and_no_filesystem_exposure(client: TestClient) -> None:
    assert client.get("/browser.html").status_code == 200
    assert client.get("/browser.js").status_code == 200
    assert client.get("/browser_server.py").status_code == 404
    assert client.get("/logs/software_versions.txt").status_code == 404


def test_gff_escaped_attribute_delimiters() -> None:
    # TEST parser text, not experimental data.
    assert read_attributes("Name=TEST%3Bescaped;ID=TEST%3Did")["Name"] == "TEST;escaped"


def test_github_pages_cors_allows_only_configured_origin(client: TestClient) -> None:
    accepted = client.options("/api/query", headers={"Origin": "https://unavailable-2374.github.io",
                              "Access-Control-Request-Method": "POST",
                              "Access-Control-Request-Headers": "content-type"})
    assert accepted.status_code == 200
    assert accepted.headers["access-control-allow-origin"] == "https://unavailable-2374.github.io"
    rejected = client.options("/api/query", headers={"Origin": "https://example.invalid",
                              "Access-Control-Request-Method": "POST"})
    assert rejected.status_code == 400
    assert "access-control-allow-origin" not in rejected.headers


def test_missing_index_rebuilt_without_modifying_inputs(store: Store, tmp_path: Path) -> None:
    # A copy of a REAL PAF, deliberately without an index; no simulated output.
    from browser_server import signature
    paf = tmp_path / SOURCE.name
    shutil.copyfile(SOURCE, paf)
    before = signature(paf)
    blocks = store.query_file(str(paf), before, "GENERATE:" + before, SEQ, 47260000, 47282000)
    assert len(blocks) == 6
    assert signature(paf) == before
    assert not Path(str(paf) + ".impg").exists()
