"""Verify the GitHub Pages frontend against the exported REAL data preview."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator

from playwright.sync_api import Page, expect, sync_playwright
import pytest

URL = os.environ.get("VGP_STATIC_URL", "http://127.0.0.1:8767")


@pytest.fixture
def page() -> Iterator[Page]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1050})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        yield page
        browser.close()
        assert not errors, errors


def load_preview(page: Page) -> None:
    page.goto(URL + "/browser.html")
    expect(page.locator(".ribbon")).to_have_count(6, timeout=60000)


def test_static_preview_is_real_and_explicitly_marked(page: Page) -> None:
    load_preview(page)
    expect(page.locator("#backend-status")).to_have_text("Recorded real-data preview")
    expect(page.locator("#connection-note")).to_contain_text("Custom samples or intervals require")
    expect(page.locator("#run-query")).to_be_disabled()
    expect(page.locator("#result-stats")).to_contain_text("3 windows")
    expect(page.locator(".sample")).to_have_count(581)
    assert page.locator(".gene").count() > 0
    page.locator(".gene[role=button]").first.click(force=True)
    expect(page.locator("#details")).to_contain_text("converted from GFF")
    page.screenshot(path="/tmp/vgp-pages-preview.png", full_page=True)


def test_static_dotplot_details_and_export(page: Page) -> None:
    load_preview(page)
    page.locator("#view-dotplot").click()
    assert page.locator(".dot-segment").count() > 0
    page.locator(".dot-segment").first.click(force=True)
    expect(page.locator("#details")).to_contain_text("cmaes/")
    with page.expect_download() as pending:
        page.locator("#export-query").click()
    data = json.loads(Path(pending.value.path()).read_text())
    assert data["site_mode"] == "precomputed_real_data_preview"
    assert data["custom_queries_available"] is False
    assert data["total_blocks"] == 6
    assert [w["annotation"]["total"] for w in data["windows"]] == [425, 7, 22]
    assert all(not b["source"].startswith("/") for b in data["blocks"])


def test_static_heatmap_handoff_does_not_fake_custom_query(page: Page) -> None:
    page.goto(URL + "/index.html", wait_until="domcontentloaded")
    page.wait_for_function("typeof DATA !== 'undefined' && DATA !== null", timeout=60000)
    expect(page.locator("header a[href='browser.html']")).to_have_count(1)
    page.evaluate("""() => {
        const row = DATA.leafOrder.findIndex(n => (DATA.speciesToAcc[n] || [])[0] === 'GCA_005190385.3');
        const col = DATA.leafOrder.findIndex(n => (DATA.speciesToAcc[n] || [])[0] === 'GCA_003287225.2');
        pinPair(row,col);
    }""")
    page.locator("#pc-browser-link").click()
    expect(page.locator(".ribbon")).to_have_count(6, timeout=60000)
    expect(page.locator("#backend-status")).to_have_text("Recorded real-data preview")
    expect(page.locator("#region-list")).to_contain_text("GCA_008658365.1")
    expect(page.locator("#run-query")).to_be_disabled()


def test_mobile_static_preview(page: Page) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    load_preview(page)
    expect(page.locator("#connect-api")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
