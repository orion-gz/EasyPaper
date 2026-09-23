"""Conservative, parser-independent reading order and source provenance.

Coordinates are unrotated PyMuPDF points, relative to the visible page top left.
Never manufacture a source position when exact normalized text cannot be found.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import unicodedata

RULE_VERSION = "1"
DIRECTIONS = {"ltr", "rtl", "vertical-rl", "vertical-lr"}
SEPARATE = {"figure", "table", "equation", "caption", "footnote", "header", "footer", "page_number"}


def normalized(text):
    chars, offsets = [], []
    for i, char in enumerate(text):
        for c in unicodedata.normalize("NFKC", char).casefold():
            if c.isalnum() or unicodedata.category(c).startswith("M"):
                chars.append(c)
                offsets.append(i)
    return "".join(chars), offsets


def valid_bbox(box):
    return (isinstance(box, (list, tuple)) and len(box) == 4
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
            and box[2] > box[0] and box[3] > box[1])


def native_blocks(page, raw=None):
    raw = raw or page.get_text("rawdict", flags=0)
    # Some producers put multiple columns into one PDF text block. Separate
    # disconnected horizontal line intervals before assigning stable IDs.
    raw = copy.deepcopy(raw)
    expanded = []
    for block in raw.get("blocks", []):
        lines = block.get("lines", [])
        if not lines:
            continue
        components = []
        for line in sorted(lines, key=lambda item: item["bbox"][0]):
            if components and line["bbox"][0] <= max(l["bbox"][2] for l in components[-1]) + 3:
                components[-1].append(line)
            else:
                components.append([line])
        for group in components:
            expanded.append({**block, "lines": sorted(group, key=lambda line: (line["bbox"][1], line["bbox"][0])),
                             "bbox": [min(l["bbox"][0] for l in group), min(l["bbox"][1] for l in group),
                                      max(l["bbox"][2] for l in group), max(l["bbox"][3] for l in group)]})
    raw["blocks"] = expanded
    result = []
    for block in raw.get("blocks", []):
        if not block.get("lines"):
            continue
        text, chars, lines = "", [], []
        for line in block["lines"]:
            start = len(text)
            for span in line.get("spans", []):
                # OCR DICT output supplies span geometry only. Keep the complete
                # span box; do not interpolate fictional glyph positions.
                for char in span.get("chars", [{"c": span.get("text", ""), "bbox": span["bbox"]}]):
                    value = char["c"]
                    chars.extend([list(char["bbox"])] * len(value))
                    text += value
            lines.append({"start": start, "end": len(text), "bbox": list(line["bbox"]),
                          "wmode": line.get("wmode", 0), "dir": line.get("dir", [1, 0]),
                          "font_size": max((span.get("size", 0) for span in line.get("spans", [])), default=0)})
            text += "\n"
            chars.append(None)
        result.append({"text": text.rstrip(), "bbox": list(block["bbox"]),
                       "source_chars": chars[:len(text.rstrip())], "lines": lines})
    return result


def _direction(block):
    explicit = block.get("writing_direction")
    if explicit in DIRECTIONS:
        return explicit, False
    lines = block.get("lines", [])
    if any(line.get("wmode") == 1 for line in lines):
        # PDF wmode specifies vertical glyph advance, not column progression.
        return "vertical-rl", True
    if any(abs(line.get("dir", [1, 0])[1]) > .5 for line in lines):
        return "ltr", True
    classes = [unicodedata.bidirectional(c) for c in block.get("text", "")]
    rtl, ltr = sum(c in {"R", "AL"} for c in classes), classes.count("L")
    return ("rtl" if rtl > ltr else "ltr"), bool(rtl and ltr and min(rtl, ltr) / max(rtl, ltr) > .4)


def _role(block, height):
    role = block.get("role")
    if role and role != "body":
        return role
    text = block.get("text", "").strip()
    if re.match(r"^(?:Fig(?:ure)?\.?|Table|그림|표)\s*\d", text, re.I):
        return "caption"
    box = block.get("bbox")
    if valid_bbox(box) and (box[1] < height * .06 or box[3] > height * .94):
        if re.fullmatch(r"\d{1,5}", text):
            return "page_number"
    return "body"


def _gaps(blocks, axis):
    intervals = sorted((b["bbox"][axis], b["bbox"][axis + 2]) for b in blocks)
    end, gaps = intervals[0][1], []
    for start, stop in intervals[1:]:
        if start - end > 3:
            gaps.append((end, start))
        end = max(end, stop)
    return gaps


def _order(blocks, direction, region="r0"):
    """Recursive whitespace cuts: gutters before rows; spanning headings split bands."""
    if len(blocks) < 2:
        for b in blocks:
            b["region_id"] = region
        return blocks, False
    left = min(b["bbox"][0] for b in blocks)
    right = max(b["bbox"][2] for b in blocks)
    spanning = sorted([b for b in blocks if b.get("role") == "title" or b["bbox"][2] - b["bbox"][0] >= (right - left) * .8],
                      key=lambda b: b["bbox"][1])
    narrow = [b for b in blocks if b not in spanning]
    if spanning and narrow and _gaps(narrow, 0):
        ordered, pending, conflict = [], list(blocks), False
        for separator in spanning:
            before = [b for b in pending if b["bbox"][3] <= separator["bbox"][1]]
            overlapping = [b for b in pending if b is not separator and b not in before
                           and b["bbox"][1] < separator["bbox"][3]]
            if overlapping:
                return blocks, True
            part, uncertain = _order(before, direction, f"{region}.band{len(ordered)}") if before else ([], False)
            separator["region_id"] = f"{region}.separator{len(ordered)}"
            ordered.extend(part + [separator])
            conflict |= uncertain
            pending = [b for b in pending if b not in before and b is not separator]
        part, uncertain = _order(pending, direction, f"{region}.tail") if pending else ([], False)
        return ordered + part, conflict or uncertain
    for axis in (0, 1):
        gaps = _gaps(blocks, axis)
        if not gaps:
            continue
        # A horizontal split is a band boundary. Use the first one so a full
        # width heading does not force subsequent columns into row-major order.
        gap = max(gaps, key=lambda g: g[1] - g[0]) if axis == 0 else gaps[0]
        cut = sum(gap) / 2
        groups = [[b for b in blocks if b["bbox"][axis] < cut],
                  [b for b in blocks if b["bbox"][axis] >= cut]]
        if axis == 0 and direction in {"rtl", "vertical-rl"}:
            groups.reverse()
        ordered, conflict = [], False
        for index, group in enumerate(groups):
            part, uncertain = _order(group, direction, f"{region}.{index}")
            ordered.extend(part)
            conflict |= uncertain
        return ordered, conflict
    for b in blocks:
        b["region_id"] = region
    # Overlapping boxes can be a table, an article beside a sidebar, or a
    # diagram. Their relative order needs semantic evidence.
    return sorted(blocks, key=lambda b: (b["bbox"][1], b["bbox"][0])), True


def _match_geometry(block, native):
    target, offsets = normalized(block.get("text", ""))
    if not target:
        return False
    candidates = []
    for source in native:
        value, positions = normalized(source["text"])
        start = value.find(target)
        while start >= 0:
            box = block.get("bbox")
            # Restrict repeated phrases by the parser's actual source rectangle.
            if not valid_bbox(box) or (min(box[2], source["bbox"][2]) > max(box[0], source["bbox"][0])
                                       and min(box[3], source["bbox"][3]) > max(box[1], source["bbox"][1])):
                candidates.append((source, positions[start:start + len(target)]))
            start = value.find(target, start + 1)
    if len(candidates) != 1:
        return False
    source, positions = candidates[0]
    chars = [None] * len(block["text"])
    for index, position in zip(offsets, positions):
        chars[index] = source["source_chars"][position]
    # Retain punctuation and spaces when the anchored source gap is identical.
    # Normalization establishes anchors only; it must not clip sentence endings.
    anchors = list(dict.fromkeys(zip(offsets, positions)))
    anchors = [(-1, positions[0] - offsets[0] - 1)] + anchors
    anchors.append((len(block["text"]), positions[-1] + len(block["text"]) - offsets[-1]))
    for (a, x), (b, y) in zip(anchors, anchors[1:]):
        if x >= -1 and block["text"][a + 1:b] == source["text"][x + 1:y]:
            chars[a + 1:b] = source["source_chars"][x + 1:y]
    block["source_chars"] = chars
    block["lines"] = source["lines"]
    if source.get("role") and block.get("role", "body") == "body":
        block["role"] = source["role"]
    if source.get("group_id"):
        block.setdefault("group_id", source["group_id"])
    block["source_bbox"] = source["bbox"]
    if not valid_bbox(block.get("bbox")):
        block["bbox"] = source["bbox"]
    return True


def _split_coarse(blocks, native):
    if len(blocks) != 1 or len(native) < 2:
        return blocks
    text, _ = normalized(blocks[0].get("text", ""))
    intervals = []
    for source in native:
        value, _ = normalized(source["text"])
        if not value or text.count(value) != 1:
            return blocks
        start = text.index(value)
        intervals.append((start, start + len(value), source))
    intervals.sort(key=lambda item: item[0])
    if intervals[0][0] or intervals[-1][1] != len(text):
        return blocks
    if any(a[1] != b[0] for a, b in zip(intervals, intervals[1:])):
        return blocks
    return [{**copy.deepcopy(source), "type": 0, "coordinate_space": "unrotated-top-left"} for _, _, source in intervals]


def normalize_page(page, native, width, height, revision, resolve=None):
    result = copy.deepcopy(page)
    result.pop("_layout_objects", None)
    result["original_text"] = page.get("text", "")
    result["original_blocks"] = copy.deepcopy(page.get("blocks", []))
    blocks = []
    for original in copy.deepcopy(page.get("blocks", [])):
        box = original.get("bbox")
        # MinerU coordinates need conversion before any spatial reconciliation.
        if page.get("parser_engine") == "mineru" or original.get("coordinate_space") == "normalized-1000":
            blocks.append(original)
            continue
        candidates = [b for b in native if not valid_bbox(box) or
                      (b["bbox"][0] >= box[0] - 1 and b["bbox"][1] >= box[1] - 1
                       and b["bbox"][2] <= box[2] + 1 and b["bbox"][3] <= box[3] + 1)]
        split = _split_coarse([original], candidates)
        for part in split:
            for key in ("role", "include_in_translation", "is_indented"):
                if key in original:
                    part.setdefault(key, original[key])
        blocks.extend(split)
    blocks.extend(copy.deepcopy(page.get("_layout_objects", [])))
    if not blocks and page.get("text"):
        blocks = [{"text": page["text"], "bbox": None, "type": 0}]
    reasons = []
    for i, block in enumerate(blocks):
        block["id"] = f"p{page['page_num']}-b{i}"
        block["original_index"] = i
        if (page.get("parser_engine") == "mineru" or block.get("coordinate_space") == "normalized-1000") and block.get("coordinate_space") != "unrotated-top-left" and valid_bbox(block.get("bbox")):
            block["parser_bbox"] = block["bbox"]
            block["bbox"] = [block["bbox"][0] * width / 1000, block["bbox"][1] * height / 1000,
                             block["bbox"][2] * width / 1000, block["bbox"][3] * height / 1000]
        if page.get("parser_engine") == "pymupdf" or block.get("coordinate_space") == "unrotated-top-left":
            block["source_text"] = block.get("text", "")
            text = re.sub(r'-\*{0,2}\n\*{0,2}(\w)', r'\1', block["source_text"])
            text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text).strip()
            if block.get("is_indented"):
                text = "\ue000" + text
            block["text"] = text
            block.pop("source_chars", None)
        mapped = bool(block.get("source_chars")) or _match_geometry(block, native)
        block["mapping_status"] = "exact" if mapped else "unresolved"
        block["source_bbox"] = block.get("source_bbox", block.get("bbox"))
        if not mapped and block.get("text", "").strip():
            reasons.append("source_mapping_failed")
        if not valid_bbox(block.get("bbox")):
            reasons.append("missing_coordinates")
        block["role"] = _role(block, height)
        if block["role"] == "page_number":
            block.setdefault("include_in_translation", False)
        direction, uncertain = _direction(block)
        block["writing_direction"] = direction
        if uncertain:
            reasons.append("ambiguous_direction")
        block["group_id"] = block.get("group_id", block["id"])
        block["region_id"] = "r0"
    body = [b for b in blocks if b["role"] not in SEPARATE]
    directions = {b["writing_direction"] for b in body}
    if len(directions) > 1:
        reasons.append("mixed_directions")
    ordered = blocks
    if blocks and all(valid_bbox(b.get("bbox")) for b in blocks):
        ordered, conflict = _order(body, next(iter(directions), "ltr")) if body else ([], False)
        if conflict:
            reasons.append("region_conflict")
        separate = [b for b in blocks if b["role"] in SEPARATE]
        for caption in [b for b in separate if b["role"] == "caption"]:
            objects = [b for b in separate if b["role"] in {"figure", "table", "equation"}
                       and min(b["bbox"][2], caption["bbox"][2]) > max(b["bbox"][0], caption["bbox"][0])]
            if any(b.get("is_layout_object") for b in objects):
                objects = [b for b in objects if b.get("is_layout_object")]
            if objects:
                obj = min(objects, key=lambda b: min(abs(b["bbox"][3] - caption["bbox"][1]), abs(caption["bbox"][3] - b["bbox"][1])))
                caption["object_id"] = obj["id"]
                caption["group_id"] = obj["group_id"]
        rank = {"figure": 0, "table": 0, "equation": 0, "caption": 1, "footnote": 2, "header": 3, "footer": 3, "page_number": 3}
        by_id = {b["id"]: b for b in separate}
        def object_order(block):
            anchor = by_id.get(block.get("object_id"), block)
            return (rank[anchor["role"]], anchor["bbox"][1], anchor["bbox"][0], block["role"] == "caption")
        ordered += sorted(separate, key=object_order)
    if page.get("text_recovery") == "failed":
        reasons.append("ocr_failed")
    method = "rules"
    if reasons:
        ordered = blocks  # retain parser order and text on any unresolved page
        method = "parser_fallback"
        if resolve and blocks:
            try:
                answer = resolve(blocks)
                ordered = validate_ai_order(answer, blocks)
                method = "vision"
                reasons = [r for r in reasons if r in {"source_mapping_failed", "missing_coordinates", "ocr_failed"}]
            except Exception:
                reasons.append("vision_failed")
    can_rebuild = method != "parser_fallback"
    parts, cursor = [], 0
    for index, block in enumerate(ordered):
        block["reading_order"] = index
        text = block.get("text", "").strip()
        block["text"] = block.get("text", "")
        if can_rebuild and text and block.get("include_in_translation", True):
            if parts:
                cursor += 2
            block["text_range"] = [cursor, cursor + len(text)]
            cursor += len(text)
            parts.append(text)
    if can_rebuild:
        result["text"] = "\n\n".join(parts)
    if not can_rebuild:
        for block in ordered:
            value = block.get("text", "").strip()
            if value and result["text"].count(value) == 1 and block.get("include_in_translation", True):
                start = result["text"].index(value)
                block["text_range"] = [start, start + len(value)]
    result["blocks"] = ordered
    result["word_count"] = len(result.get("text", "").split())
    result["layout"] = {"rule_version": RULE_VERSION, "source_revision": revision,
                        "method": method, "model": getattr(resolve, "model_identity", None), "needs_review": bool(reasons), "reasons": sorted(set(reasons)),
                        "coordinate_space": "unrotated-top-left", "width": width, "height": height}
    result["layout"]["layout_revision"] = hashlib.sha256(json.dumps(
        [revision, RULE_VERSION, result["layout"]["model"], result["text"],
         [(b["id"], b.get("text_range"), b.get("source_chars")) for b in ordered]],
        sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    result["reading_order_suspicious"] = bool(reasons)
    return result


def validate_ai_order(answer, blocks):
    entries = answer.get("blocks") if isinstance(answer, dict) else None
    if not isinstance(entries, list) or len(entries) != len(blocks):
        raise ValueError("incomplete layout")
    ids = [b["id"] for b in blocks]
    seen, result = set(), []
    lookup = {b["id"]: b for b in blocks}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid block")
        identifier = entry.get("id")
        if not isinstance(identifier, str) or identifier not in ids or identifier in seen:
            raise ValueError("invalid block reference")
        if entry.get("direction") not in DIRECTIONS:
            raise ValueError("invalid direction")
        if not all(isinstance(entry.get(k), str) and 0 < len(entry[k]) <= 100 for k in ("region", "group")):
            raise ValueError("invalid group")
        seen.add(identifier)
        block = copy.deepcopy(lookup[identifier])
        block.update(region_id=entry["region"], group_id=entry["group"], writing_direction=entry["direction"])
        result.append(block)
    # Groups must be contiguous; otherwise unrelated articles could interleave.
    for key in ("region_id", "group_id"):
        closed, last = set(), None
        for block in result:
            value = block[key]
            if value != last:
                if value in closed:
                    raise ValueError("interleaved groups")
                closed.add(value)
                last = value
    separated = False
    for block in result:
        if block.get("role") in SEPARATE:
            separated = True
        elif separated:
            raise ValueError("object interrupts body")
        if block.get("object_id"):
            obj = next(b for b in result if b["id"] == block["object_id"])
            if obj["group_id"] != block["group_id"]:
                raise ValueError("detached caption")
    return result


def normalize_document(pages, pdf_path):
    import fitz
    from services.pdf_diagnostics import pdf_fingerprint
    from services.pdf_layout_vision import resolver_for_page
    revision = pdf_fingerprint(pdf_path)
    result = []
    from collections import Counter
    with fitz.open(pdf_path) as doc:
        margin_counts = Counter()
        for page in pages:
            source = doc[page["page_num"] - 1]
            rect = source.rect * source.derotation_matrix
            margins = source.get_text("blocks")
            margin_counts.update(set(normalized(b[4])[0] for b in margins
                                     if b[6] == 0 and (b[1] < rect.height * .07 or b[3] > rect.height * .93)))
        for page in pages:
            source = doc[page["page_num"] - 1]
            native = page.get("_layout_native") or native_blocks(source)
            page = copy.deepcopy(page)
            page.pop("_layout_native", None)
            # PyMuPDF boxes are always unrotated, including rotated/cropped PDFs.
            rect = source.rect * source.derotation_matrix
            from services.pdf_parser import _find_page_equations, _find_vector_figure_rects
            regions = [(item["bbox"], "equation", f"equation-{index}") for index, item in enumerate(_find_page_equations(source))]
            try:
                regions.extend((list(table.bbox), "table", f"table-{index}") for index, table in enumerate(source.find_tables().tables))
            except Exception:
                # Table detection is optional geometric evidence; never drop text.
                pass
            objects = list(regions)
            if not page.get("text_recovery"):
                figures = [item["bbox"] for item in source.get_image_info()] + _find_vector_figure_rects(source)
                objects.extend((box, "figure", f"figure-{index}") for index, box in enumerate(figures))
            page["_layout_objects"] = [
                {"bbox": list(box), "text": "", "type": 1, "role": role, "group_id": group,
                 "coordinate_space": "unrotated-top-left", "include_in_translation": False, "is_layout_object": True}
                for box, role, group in objects if valid_bbox(box)
            ]
            for block in native:
                box = block["bbox"]
                area = (box[2] - box[0]) * (box[3] - box[1])
                for region, role, group in regions:
                    overlap = max(0, min(box[2], region[2]) - max(box[0], region[0])) * max(0, min(box[3], region[3]) - max(box[1], region[1]))
                    if area and overlap / area > .8:
                        block.update(role=role, group_id=group)
                        break
            sizes = sorted(line["font_size"] for b in native for line in b.get("lines", []) if line.get("font_size"))
            median_size = sizes[len(sizes) // 2] if sizes else 0
            for block in native:
                size = max((line.get("font_size", 0) for line in block.get("lines", [])), default=0)
                if margin_counts[normalized(block["text"])[0]] >= 2:
                    if block["bbox"][1] < rect.height * .07:
                        block["role"] = "header"
                    elif block["bbox"][3] > rect.height * .93:
                        block["role"] = "footer"
                if not block.get("role") and median_size:
                    if size > median_size * 1.35:
                        block["role"] = "title"
                    elif size < median_size * .85 and block["bbox"][1] > rect.height * .8:
                        block["role"] = "footnote"
            resolve = resolver_for_page(pdf_path, page["page_num"], revision)
            result.append(normalize_page(page, native, rect.width, rect.height, revision, resolve))
    return result


def attach_source_mappings(sentences, page):
    """Attach exact character ranges and boxes. Legacy pages keep their old schema."""
    if not page.get("layout"):
        return sentences
    text = page.get("text", "")
    value, offsets = normalized(text)
    cursor = 0
    for index, sentence in enumerate(sentences):
        source_text = sentence.get("src", "")
        target, source_offsets = normalized(source_text)
        start = value.find(target, cursor) if target else -1
        mapping = {"status": "unresolved", "segments": [], "coordinate_space": "unrotated-top-left",
                   "source_revision": page["layout"]["source_revision"]}
        layout_revision = page["layout"].get("layout_revision", page["layout"]["source_revision"])
        mapping["layout_revision"] = layout_revision
        sentence["id"] = f"{layout_revision[:12]}-p{page['page_num']}-s{index}"
        sentence["source_mapping"] = mapping
        if start < 0:
            continue
        end = start + len(target)
        raw_start, raw_end = offsets[start], offsets[end - 1] + 1
        prefix, suffix = source_text[:source_offsets[0]], source_text[source_offsets[-1] + 1:]
        if prefix and raw_start >= len(prefix) and text[raw_start - len(prefix):raw_start] == prefix:
            raw_start -= len(prefix)
        if suffix and text[raw_end:raw_end + len(suffix)] == suffix:
            raw_end += len(suffix)
        cursor = end
        segments = []
        covered = ""
        for block in page.get("blocks", []):
            span = block.get("text_range")
            if not span:
                continue
            a, b = max(raw_start, span[0]), min(raw_end, span[1])
            if a >= b:
                continue
            local_a, local_b = a - span[0], b - span[0]
            leading = len(block["text"]) - len(block["text"].lstrip())
            chars = block.get("source_chars", [])[local_a + leading:local_b + leading]
            boxes = []
            for box in chars:
                if valid_bbox(box) and box not in boxes:
                    boxes.append(box)
            part = block["text"].strip()[local_a:local_b]
            # Every meaningful character needs evidence, not merely one box.
            indices = normalized(part)[1]
            if any(i >= len(chars) or not valid_bbox(chars[i]) for i in indices):
                boxes = []
            if not boxes:
                break
            covered += normalized(part)[0]
            segments.append({"block_id": block["id"], "char_range": [local_a + leading, local_b + leading],
                             "writing_direction": block.get("writing_direction", "ltr"), "rects": boxes})
        if segments and covered == target:
            mapping.update(status="exact", text_range=[raw_start, raw_end], segments=segments)
    return sentences
