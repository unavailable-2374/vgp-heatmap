"""Chromium end-to-end checks using REAL VGP results from a running region API."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator
from urllib.parse import urlencode

from playwright.sync_api import Page, expect, sync_playwright
import pytest

URL = os.environ.get("VGP_BROWSER_URL", "http://127.0.0.1:8766")
REQUEST = {"mode": "anchor", "dataset": "cmaes", "windows": [{"accession": "GCA_005190385.3",
           "seq": "GCA_005190385.3#0#SIHG02000020.1", "start": 47260000, "end": 47282000}],
           "targets": ["GCA_003287225.2"], "min_identity": 0, "min_length": 0, "direction": "preferred"}


@pytest.fixture
def page() -> Iterator[Page]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1050})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        yield page
        browser.close()
        assert not errors, f"Browser runtime errors: {errors}"


def load_real_view(page: Page) -> None:
    page.goto(URL + "/browser.html#" + urlencode({"view": json.dumps(REQUEST)}))
    expect(page.locator(".ribbon")).to_have_count(6, timeout=180000)


def test_catalog_selection_and_invalid_input(page: Page) -> None:
    page.goto(URL + "/browser.html")
    expect(page.locator(".sample")).to_have_count(581)
    page.locator("#sample-search").fill("GCA_005190385.3")
    expect(page.locator(".sample")).to_have_count(1)
    page.locator(".sample button").click()
    expect(page.locator(".region")).to_have_count(1)
    page.locator("#sample-search").fill("GCA_003287225.2")
    page.locator(".sample button").click()
    expect(page.locator(".region")).to_have_count(2)
    page.get_by_label("start 1", exact=True).fill("-1")
    page.locator("#run-query").click()
    expect(page.locator("#status")).to_contain_text("Invalid interval")
    expect(page.locator("#export-query")).to_be_disabled()
    page.get_by_label("start 1", exact=True).fill("0")
    page.locator("#mode-anchor").click()
    expect(page.locator(".region")).to_have_count(1)
    expect(page.locator(".target-chip")).to_have_count(1)


def test_real_tracks_details_dotplot_and_export(page: Page) -> None:
    load_real_view(page)
    expect(page.locator("#status")).to_contain_text("6 blocks")
    page.locator(".ribbon").first.click(force=True)
    expect(page.locator("#details")).to_contain_text("Direct alignment")
    expect(page.locator("#details")).to_contain_text("cmaes/GCA_003287225.2_vs_GCA_005190385.3.paf.gz")
    page.screenshot(path="/tmp/vgp-browser-tracks.png", full_page=True)
    page.locator("#view-dotplot").click()
    expect(page.locator(".dot-segment")).to_have_count(2)
    page.locator(".dot-segment").first.click(force=True)
    expect(page.locator("#details")).to_contain_text("Base identity")
    page.screenshot(path="/tmp/vgp-browser-dotplot.png", full_page=True)
    with page.expect_download() as download:
        page.locator("#export-query").click()
    result = json.loads(Path(download.value.path()).read_text())
    assert result["total_blocks"] == 6
    assert result["coordinate_system"] == "0-based half-open"
    page.locator("#min-identity").fill("100")
    page.locator("#run-query").click()
    expect(page.locator("#status")).to_contain_text("0 blocks", timeout=180000)
    expect(page.locator(".dot-segment")).to_have_count(0)


def test_dotplot_brush_and_requery(page: Page) -> None:
    load_real_view(page)
    page.locator("#view-dotplot").click()
    box = page.locator("#visualization svg").bounding_box()
    assert box
    # Brush the entire plot area (inside both axis limits) using actual screen coordinates.
    sx, sy = box["width"] / 850, box["height"] / 480
    page.mouse.move(box["x"] + 110*sx, box["y"] + 35*sy)
    page.mouse.down()
    page.mouse.move(box["x"] + 820*sx, box["y"] + 405*sy, steps=8)
    page.mouse.up()
    expect(page.locator(".region")).to_have_count(2)
    expect(page.locator("#result-title")).to_have_text("Direct pairwise alignments", timeout=180000)
    expect(page.locator(".dot-segment")).to_have_count(2)


def test_mobile_layout_and_saved_view(page: Page) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    load_real_view(page)
    expect(page.locator("#run-query")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.screenshot(path="/tmp/vgp-browser-mobile.png", full_page=True)


def test_three_assemblies_with_real_gene_models(page: Page) -> None:
    # REAL locus selected from an existing alignment overlapping a GFF gene.
    body = {"mode": "anchor", "dataset": "cmaes", "windows": [{"accession": "GCA_008658365.1",
            "seq": "GCA_008658365.1#0#CM018077.1", "start": 164762841, "end": 164785333}],
            "targets": ["GCA_009764595.1", "GCA_009769465.1"], "min_identity": 0,
            "min_length": 0, "direction": "preferred"}
    page.goto(URL + "/browser.html#" + urlencode({"view": json.dumps(body)}))
    expect(page.locator(".ribbon")).to_have_count(6, timeout=180000)
    expect(page.locator("#result-stats")).to_contain_text("3 windows")
    assert page.locator(".gene").count() > 0
    page.locator(".gene[role=button]").first.click(force=True)
    expect(page.locator("#details")).to_contain_text("GFF sequence")
    expect(page.locator("#details")).to_contain_text("converted from GFF")
    rect = page.locator("rect.gene").first
    start, end = int(rect.get_attribute("data-start")), int(rect.get_attribute("data-end"))
    assert start < end
    rect.click(force=True)
    expect(page.locator("#details")).to_contain_text(f"{start}-{end}")
    page.screenshot(path="/tmp/vgp-browser-annotated.png", full_page=True)
    page.locator("#show-genes").uncheck()
    expect(page.locator(".gene")).to_have_count(0)
    expect(page.locator(".ribbon")).to_have_count(6)


def test_heatmap_selection_handoff(page: Page) -> None:
    page.goto(URL + "/index.html", wait_until="domcontentloaded")
    page.wait_for_function("typeof DATA !== 'undefined' && DATA !== null", timeout=60000)
    page.evaluate("""() => {
      const row = DATA.leafOrder.findIndex(n => (DATA.speciesToAcc[n] || [])[0] === 'GCA_005190385.3');
      const col = DATA.leafOrder.findIndex(n => (DATA.speciesToAcc[n] || [])[0] === 'GCA_003287225.2');
      if (row < 0 || col < 0) throw new Error('REAL heatmap accessions not found');
      pinPair(row, col);
    }""")
    page.locator("#pc-browser-link").click()
    expect(page.locator(".region")).to_have_count(2)
    expect(page.locator("#status")).to_contain_text("Heatmap assemblies loaded")
    expect(page.locator("#dataset")).to_have_value("cmaes")
