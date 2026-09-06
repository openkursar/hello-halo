#!/usr/bin/env python3
"""Generate the large perf fixtures into ./generated/.

Every writer here must be a pure function of its arguments: no RNG, no clock,
no external tool, no filesystem ordering. The suite verifies the output against
`manifest.json` and aborts on any mismatch, so a non-deterministic writer would
turn every run on every other machine into a hard failure.

    python3 generate.py                 # write ./generated/
    python3 generate.py --manifest      # also rewrite manifest.json
"""
import hashlib
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "generated")
MANIFEST = os.path.join(HERE, "manifest.json")


def p(name):
    return os.path.join(OUT, name)


# ---------- markdown ----------

def gen_markdown(path, target_bytes):
    parts = []
    parts.append("# Perf Fixture Markdown\n\n")
    parts.append("This file is generated for Halo file-preview performance testing.\n\n")
    i = 0
    while sum(len(x) for x in parts) < target_bytes:
        i += 1
        parts.append(f"## Section {i}\n\n")
        parts.append(
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit. "
            "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. "
            "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.\n\n"
        )
        parts.append("| Col A | Col B | Col C | Col D |\n")
        parts.append("|---|---|---|---|\n")
        for r in range(8):
            parts.append(f"| row{r}-a | row{r}-b | {r * 3.14:.2f} | value-{i}-{r} |\n")
        parts.append("\n")
        parts.append("```ts\n")
        parts.append(f"function section{i}(input: number): number {{\n")
        parts.append("  let acc = 0\n")
        parts.append("  for (let idx = 0; idx < input; idx++) {\n")
        parts.append("    acc += idx * idx - (idx % 7)\n")
        parts.append("  }\n")
        parts.append("  return acc\n")
        parts.append("}\n")
        parts.append("```\n\n")
        parts.append(f"![diagram {i}](https://example.com/assets/diagram-{i}.png)\n\n")
        parts.append("> Blockquote note for section %d explaining a caveat in the flow.\n\n" % i)
        parts.append("- bullet one\n- bullet two\n- bullet three\n\n")
    with open(path, "w") as f:
        f.write("".join(parts))


# ---------- code ----------

def gen_code(path, n_lines):
    lines = []
    lines.append("// Generated fixture code file for perf testing (syntax highlighting load).")
    lines.append("import { useCallback, useEffect, useMemo, useState } from 'react'")
    lines.append("")
    body_lines_target = n_lines - 3
    written = 0
    idx = 0
    while written < body_lines_target:
        idx += 1
        lines.append(f"export function computeValue{idx}(a: number, b: number, label: string): number {{")
        lines.append(f"  const base = a * {idx} + b / ({idx} + 1)")
        lines.append("  let result = base")
        lines.append(f"  for (let i = 0; i < {(idx % 23) + 1}; i++) {{")
        lines.append("    result += Math.sin(result) * Math.cos(i)")
        lines.append("    if (result > 1e6) {")
        lines.append("      result = result % 1e6")
        lines.append("    }")
        lines.append("  }")
        lines.append(f"  console.debug(label, result, {idx})")
        lines.append("  return result")
        lines.append("}")
        lines.append("")
        written += 12
    with open(path, "w") as f:
        f.write("\n".join(lines[:n_lines]) + "\n")


# ---------- JSON ----------

def gen_json(path, target_bytes):
    """`value` used to be `random.random()`, which made this the only
    non-reproducible fixture in the set; it is now derived from the index."""
    items = []
    size = 2
    i = 0
    while size < target_bytes:
        i += 1
        item = {
            "id": i,
            "name": f"item-{i}",
            "value": round((i * 2654435761 % 100000000) / 10000.0, 4),
            "active": i % 3 == 0,
            "tags": [f"tag{i % 5}", f"tag{i % 11}", f"tag{i % 17}"],
            "meta": {
                "createdAt": f"2026-01-{(i % 28) + 1:02d}T00:00:00Z",
                "score": i * 0.37 % 100,
                "nested": {"a": i, "b": i * 2, "c": [i, i + 1, i + 2]},
            },
        }
        items.append(item)
        size += len(json.dumps(item))
    with open(path, "w") as f:
        json.dump({"generated": True, "count": len(items), "items": items}, f)


# ---------- CSV ----------

def gen_csv(path, target_bytes):
    header = "id,name,category,value,quantity,price,total,timestamp,notes\n"
    rows = [header]
    size = len(header)
    i = 0
    categories = ["alpha", "beta", "gamma", "delta", "epsilon"]
    while size < target_bytes:
        i += 1
        qty = i % 50 + 1
        price = round((i % 997) * 1.13, 2)
        total = round(qty * price, 2)
        row = f"{i},item-{i},{categories[i % 5]},{i * 0.5},{qty},{price},{total},2026-01-{(i % 28) + 1:02d},note for row {i}\n"
        rows.append(row)
        size += len(row)
    with open(path, "w") as f:
        f.write("".join(rows))


def gen_csv_tall(path, target_bytes):
    """Same byte size as gen_csv, three columns instead of nine.

    Row count, not file size, is what a per-row spread argument blows up on, and
    the wide-and-short 5MB fixture holds only ~67k rows -- about half the limit,
    so it measured clean while the far more common narrow shape still crashed.
    """
    header = "ts,level,msg\n"
    rows = [header]
    size = len(header)
    i = 0
    levels = ["INFO", "WARN", "ERROR"]
    while size < target_bytes:
        i += 1
        row = f"{i},{levels[i % 3]},e{i}\n"
        rows.append(row)
        size += len(row)
    with open(path, "w") as f:
        f.write("".join(rows))


# ---------- PNG ----------

def _png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def gen_image(path, width, height):
    """Encoded here rather than shelled out to `sips`, which exists only on
    macOS and pins the fixture's bytes to the host's image toolchain."""
    red = bytes(x * 255 // max(1, width) for x in range(width))
    blue = bytes(k * 255 // max(1, width + height) for k in range(width + height))
    raw = bytearray()
    row = bytearray(width * 3)
    for y in range(height):
        row[0::3] = red
        row[1::3] = bytes([y * 255 // max(1, height)]) * width
        row[2::3] = blue[y:y + width]
        raw.append(0)  # PNG filter type: None
        raw += row
    out = b"\x89PNG\r\n\x1a\n"
    out += _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    out += _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    out += _png_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


# ---------- PDF ----------

def gen_pdf(path, n_pages):
    objs = []
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + i} 0 R" for i in range(n_pages))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>")
    font_obj_num = 3 + n_pages
    content_start = font_obj_num + 1
    for i in range(n_pages):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 {font_obj_num} 0 R >> >> "
            f"/MediaBox [0 0 612 792] /Contents {content_start + i} 0 R >>"
        )
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i in range(n_pages):
        text = f"Perf fixture PDF - page {i + 1} of {n_pages}. Lorem ipsum dolor sit amet."
        stream = f"BT /F1 18 Tf 50 700 Td ({text}) Tj ET"
        for line in range(30):
            stream += f" BT /F1 10 Tf 50 {650 - line * 18} Td (Body line {line} on page {i + 1} - filler text for rendering load.) Tj ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")

    out = bytearray()
    out += b"%PDF-1.4\n"
    offsets = [0]
    for idx, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n{body}\nendobj\n".encode()
    xref_offset = len(out)
    total_objs = len(objs) + 1
    out += f"xref\n0 {total_objs}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {total_objs} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF".encode()
    with open(path, "wb") as f:
        f.write(bytes(out))


# ---------- HTML ----------

def gen_html(path, target_bytes):
    parts = []
    parts.append("<!doctype html>\n<html><head><meta charset='utf-8'><title>Perf Fixture</title>\n")
    parts.append("<style>body{font-family:sans-serif} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:4px}</style>\n")
    parts.append("</head><body>\n<h1>Perf Fixture HTML</h1>\n")
    i = 0
    while sum(len(x) for x in parts) < target_bytes:
        i += 1
        parts.append(f"<h2>Section {i}</h2>\n")
        parts.append("<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.</p>\n")
        parts.append("<table><thead><tr><th>Col A</th><th>Col B</th><th>Col C</th></tr></thead><tbody>\n")
        for r in range(8):
            parts.append(f"<tr><td>row{r}-a</td><td>row{r}-b</td><td>{r * 3.14:.2f}</td></tr>\n")
        parts.append("</tbody></table>\n")
        parts.append(f"<script>console.log('section {i} loaded')</script>\n")
        parts.append(f"<ul><li>item {i}-1</li><li>item {i}-2</li><li>item {i}-3</li></ul>\n")
    parts.append("</body></html>\n")
    with open(path, "w") as f:
        f.write("".join(parts))


# ---------- plain text / log ----------

def gen_text_log(path, target_bytes):
    lines = []
    size = 0
    i = 0
    levels = ["INFO", "WARN", "ERROR", "DEBUG"]
    while size < target_bytes:
        i += 1
        line = f"2026-09-04T12:{i % 60:02d}:{i % 60:02d}Z [{levels[i % 4]}] worker-{i % 8} processed request id={i} duration={(i % 500)}ms status=ok payload_size={(i * 37) % 4096}\n"
        lines.append(line)
        size += len(line)
    with open(path, "w") as f:
        f.write("".join(lines))


# ---------- Jupyter notebook ----------

def gen_notebook(path, n_cells):
    cells = []
    for i in range(n_cells):
        cells.append({
            "cell_type": "markdown",
            "metadata": {},
            "source": [f"## Section {i}\n", "Some explanatory markdown text for this cell.\n"],
        })
        cells.append({
            "cell_type": "code",
            "execution_count": i + 1,
            "metadata": {},
            "outputs": [
                {"output_type": "stream", "name": "stdout", "text": [f"result-{i}: {i * i}\n"]}
            ],
            "source": [
                f"def f{i}(x):\n",
                "    acc = 0\n",
                "    for j in range(x):\n",
                "        acc += j * j\n",
                "    return acc\n",
                f"print('result-{i}:', f{i}({i % 50 + 1}))\n",
            ],
        })
    nb = {
        "cells": cells,
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    with open(path, "w") as f:
        json.dump(nb, f)


FIXTURES = [
    ("md-typical-5kb.md", lambda: gen_markdown(p("md-typical-5kb.md"), 5 * 1024)),
    ("md-extreme-2mb.md", lambda: gen_markdown(p("md-extreme-2mb.md"), 2 * 1024 * 1024)),
    ("code-typical-200lines.ts", lambda: gen_code(p("code-typical-200lines.ts"), 200)),
    ("code-extreme-20000lines.ts", lambda: gen_code(p("code-extreme-20000lines.ts"), 20000)),
    ("json-typical-small.json", lambda: gen_json(p("json-typical-small.json"), 10 * 1024)),
    ("json-extreme-large.json", lambda: gen_json(p("json-extreme-large.json"), 5 * 1024 * 1024)),
    ("csv-typical.csv", lambda: gen_csv(p("csv-typical.csv"), 50 * 1024)),
    ("csv-medium-500kb.csv", lambda: gen_csv(p("csv-medium-500kb.csv"), 500 * 1024)),
    ("csv-extreme-large.csv", lambda: gen_csv(p("csv-extreme-large.csv"), 5 * 1024 * 1024)),
    ("csv-extreme-tall.csv", lambda: gen_csv_tall(p("csv-extreme-tall.csv"), 5 * 1024 * 1024)),
    ("image-typical.png", lambda: gen_image(p("image-typical.png"), 800, 600)),
    ("image-extreme-huge.png", lambda: gen_image(p("image-extreme-huge.png"), 6000, 4000)),
    ("pdf-typical.pdf", lambda: gen_pdf(p("pdf-typical.pdf"), 5)),
    ("pdf-extreme-large.pdf", lambda: gen_pdf(p("pdf-extreme-large.pdf"), 300)),
    ("notebook-typical.ipynb", lambda: gen_notebook(p("notebook-typical.ipynb"), 10)),
    ("notebook-extreme-large.ipynb", lambda: gen_notebook(p("notebook-extreme-large.ipynb"), 800)),
    ("html-typical.html", lambda: gen_html(p("html-typical.html"), 5 * 1024)),
    ("html-extreme-2mb.html", lambda: gen_html(p("html-extreme-2mb.html"), 2 * 1024 * 1024)),
    ("text-typical.log", lambda: gen_text_log(p("text-typical.log"), 5 * 1024)),
    ("text-extreme-5mb.log", lambda: gen_text_log(p("text-extreme-5mb.log"), 5 * 1024 * 1024)),
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    entries = {}
    for name, write in FIXTURES:
        write()
        entries[name] = {"bytes": os.path.getsize(p(name)), "sha256": sha256(p(name))}
        print(f"{name}\t{entries[name]['bytes']}\t{entries[name]['sha256'][:16]}")

    if "--manifest" in sys.argv:
        with open(MANIFEST, "w") as f:
            json.dump({"fixtures": entries}, f, indent=2, sort_keys=True)
            f.write("\n")
        print(f"wrote {MANIFEST}")
        return

    if not os.path.exists(MANIFEST):
        print(f"\nNo manifest at {MANIFEST} — rerun with --manifest to create one.", file=sys.stderr)
        sys.exit(1)
    with open(MANIFEST) as f:
        expected = json.load(f)["fixtures"]
    bad = [n for n, e in entries.items() if expected.get(n) != e]
    if bad:
        print(f"\nGenerated output does not match manifest.json: {', '.join(sorted(bad))}", file=sys.stderr)
        sys.exit(1)
    print("\nAll fixtures match manifest.json.")


if __name__ == "__main__":
    main()
