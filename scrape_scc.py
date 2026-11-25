#!/usr/bin/env python3
"""
Scrapes all Tables and Views across all modules
from Oracle Fusion Cloud SCM 26D documentation (OEDSC) and generates
data/scc_schema.json and data/scc_schema.js for the column search dashboard.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
import json
import re
import sys
import urllib.request

BASE_URL = "https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/26d/oedsc/"
TOC_URL = BASE_URL + "toc.htm"
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"

TARGET_MODULE_NUMBERS = None  # None = all modules


def fetch_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; SCM-Schema-Indexer/2.0)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_tags(html_fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html_fragment)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_toc(toc_html: str) -> tuple[list[dict], list[str]]:
    parts = re.split(r'(<li><span class="wrap">\d+\s+[^<]+</span>)', toc_html)
    entries: list[dict] = []
    modules_found: list[str] = []

    for i in range(1, len(parts), 2):
        header = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        m = re.search(r">(\d+\s+[^<]+)<", header)
        if not m:
            continue
        module_title = unescape(m.group(1)).strip()
        module_num = int(module_title.split()[0])
        if TARGET_MODULE_NUMBERS is not None and module_num not in TARGET_MODULE_NUMBERS:
            continue

        sections = re.findall(
            r'<li><span class="wrap">(Tables|Views)</span><ul>(.*?)</ul>\s*</li>',
            body,
            re.S,
        )
        if not sections:
            continue

        modules_found.append(module_title)
        for kind, sec_body in sections:
            obj_type = "TABLE" if kind == "Tables" else "VIEW"
            for href, name in re.findall(r'<a href="([^"]+)">([^<]+)</a>', sec_body):
                page = href.split("#")[0]
                entries.append(
                    {
                        "name": unescape(name).strip(),
                        "type": obj_type,
                        "module": module_title,
                        "moduleNum": module_num,
                        "href": href,
                        "url": BASE_URL + page,
                    }
                )

    if not entries:
        raise RuntimeError("No tables or views found for target modules in toc.htm")

    return entries, modules_found


def parse_object_page(entry: dict) -> dict:
    html = fetch_text(entry["url"])

    # Description: first <p class="p"> inside <div class="body"> before <section
    description = ""
    body_m = re.search(r'<div class="body">(.*?)<section', html, re.S)
    if body_m:
        ps = [strip_tags(p) for p in re.findall(r'<p class="p">(.*?)</p>', body_m.group(1), re.S)]
        description = " ".join(p for p in ps if p).strip()

    # Details
    details: dict[str, str] = {}
    det_m = re.search(
        r'<h2 class="title sectiontitle">Details</h2>(.*?)</section>', html, re.S
    )
    if det_m:
        for li in re.findall(r'<p class="p">(.*?)</p>', det_m.group(1), re.S):
            txt = strip_tags(li)
            if ":" in txt:
                k, v = txt.split(":", 1)
                details[k.strip().lower()] = v.strip()

    # Primary key
    primary_key: list[str] = []
    pk_m = re.search(
        r'<table[^>]*summary="Primary Key"[^>]*>(.*?)</table>', html, re.S
    )
    if pk_m:
        tbody_m = re.search(r"<tbody[^>]*>(.*?)</tbody>", pk_m.group(1), re.S)
        if tbody_m:
            tds = re.findall(r"<td[^>]*>(.*?)</td>", tbody_m.group(1), re.S)
            if len(tds) >= 2:
                pk_cols = [strip_tags(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", tds[1], re.S)]
                if pk_cols:
                    primary_key = [c for c in pk_cols if c]
                else:
                    raw = strip_tags(tds[1])
                    if raw:
                        primary_key = [c.strip() for c in raw.split(",") if c.strip()]

    # Columns
    columns: list[dict] = []
    col_table_m = re.search(
        r'<table[^>]*summary="Columns"[^>]*>(.*?)</table>', html, re.S
    )
    if col_table_m:
        tbl_html = col_table_m.group(1)
        headers = [
            strip_tags(th).lower()
            for th in re.findall(r"<th[^>]*>(.*?)</th>", tbl_html, re.S)
        ]
        tbody_m = re.search(r"<tbody[^>]*>(.*?)</tbody>", tbl_html, re.S)
        if tbody_m:
            rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tbody_m.group(1), re.S)
            if len(headers) == 1 and headers[0] == "name":
                for row in rows:
                    ps = re.findall(r"<p[^>]*>(.*?)</p>", row, re.S)
                    if ps:
                        for p in ps:
                            col_name = strip_tags(p)
                            if col_name:
                                columns.append(
                                    {
                                        "name": col_name,
                                        "datatype": "",
                                        "length": "",
                                        "precision": "",
                                        "notNull": False,
                                        "comments": "",
                                    }
                                )
                    else:
                        col_name = strip_tags(row)
                        if col_name:
                            columns.append(
                                {
                                    "name": col_name,
                                    "datatype": "",
                                    "length": "",
                                    "precision": "",
                                    "notNull": False,
                                    "comments": "",
                                }
                            )
            else:
                for row in rows:
                    tds = [strip_tags(td) for td in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
                    if not tds or not tds[0]:
                        continue
                    col_map = dict(zip(headers, tds))
                    columns.append(
                        {
                            "name": col_map.get("name", tds[0]),
                            "datatype": col_map.get("datatype", ""),
                            "length": col_map.get("length", ""),
                            "precision": col_map.get("precision", ""),
                            "notNull": col_map.get("not-null", "").lower() == "yes",
                            "comments": col_map.get("comments", ""),
                        }
                    )

    # View SQL Query (if present)
    query = ""
    q_m = re.search(r'<table[^>]*summary="Query"[^>]*>(.*?)</table>', html, re.S)
    if q_m:
        tbody_m = re.search(r"<tbody[^>]*>(.*?)</tbody>", q_m.group(1), re.S)
        if tbody_m:
            lines = [strip_tags(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", tbody_m.group(1), re.S)]
            query = "\n".join(lines).strip()

    return {
        "name": entry["name"],
        "type": entry["type"],
        "module": entry["module"],
        "moduleNum": entry["moduleNum"],
        "url": entry["url"],
        "description": description,
        "schema": details.get("schema", "FUSION"),
        "owner": details.get("object owner", ""),
        "tablespace": details.get("tablespace", ""),
        "primaryKey": primary_key,
        "columns": columns,
        "query": query,
    }


def main() -> int:
    print(f"Fetching TOC from {TOC_URL} ...")
    toc_html = fetch_text(TOC_URL)
    entries, modules_found = parse_toc(toc_html)
    print(
        f"Found {len(entries)} objects across {len(modules_found)} modules "
        f"({sum(1 for e in entries if e['type']=='TABLE')} tables, "
        f"{sum(1 for e in entries if e['type']=='VIEW')} views)."
    )

    results: list[dict] = []
    errors: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=24) as pool:
        future_map = {pool.submit(parse_object_page, e): e for e in entries}
        for i, fut in enumerate(as_completed(future_map), 1):
            entry = future_map[fut]
            try:
                results.append(fut.result())
            except Exception as exc:
                errors.append((entry["name"], str(exc)))
            if i % 100 == 0 or i == len(entries):
                print(f"  Processed {i}/{len(entries)}...")

    if errors:
        print(f"Errors ({len(errors)}):", errors[:20], file=sys.stderr)
        return 1

    # Sort: Module number, then Tables first alphabetically, then Views alphabetically
    results.sort(key=lambda x: (x["moduleNum"], 0 if x["type"] == "TABLE" else 1, x["name"]))

    unique_cols = {c["name"] for obj in results for c in obj["columns"]}
    total_col_occurrences = sum(len(obj["columns"]) for obj in results)

    payload = {
        "meta": {
            "sourceUrl": BASE_URL + "index.html",
            "release": "26D",
            "modules": modules_found,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "tableCount": sum(1 for r in results if r["type"] == "TABLE"),
            "viewCount": sum(1 for r in results if r["type"] == "VIEW"),
            "uniqueColumnCount": len(unique_cols),
            "totalColumnOccurrences": total_col_occurrences,
        },
        "objects": results,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    json_path = DATA_DIR / "scc_schema.json"
    js_path = DATA_DIR / "scc_schema.js"

    json_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    json_path.write_text(json_text, encoding="utf-8")
    js_path.write_text(f"window.SCC_SCHEMA={json_text};\n", encoding="utf-8")

    print(
        f"Done! Wrote {json_path} ({json_path.stat().st_size / 1024 / 1024:.2f} MB) and {js_path}\n"
        f"  Modules: {len(modules_found)}\n"
        f"  Tables: {payload['meta']['tableCount']}, Views: {payload['meta']['viewCount']}\n"
        f"  Unique columns: {payload['meta']['uniqueColumnCount']}, Total column entries: {payload['meta']['totalColumnOccurrences']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
