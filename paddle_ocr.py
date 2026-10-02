import json
import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from paddleocr import PaddleOCR

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def polygon_to_box(polygon):
    if hasattr(polygon, "tolist"):
        polygon = polygon.tolist()
    if not polygon:
        return {"left": 0, "top": 0, "right": 0, "bottom": 0}
    points = []
    for point in polygon:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            points.append((float(point[0]), float(point[1])))
    if not points:
        return {"left": 0, "top": 0, "right": 0, "bottom": 0}
    return {
        "left": min(point[0] for point in points),
        "top": min(point[1] for point in points),
        "right": max(point[0] for point in points),
        "bottom": max(point[1] for point in points),
    }


def normalize_text(value):
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], str):
            return str(value[0]).strip()
        return " ".join(normalize_text(item) for item in value if normalize_text(item)).strip()
    if isinstance(value, dict):
        for key in ("text", "transcription", "rec_text", "value", "label"):
            if key in value and value[key] not in (None, ""):
                return str(value[key]).strip()
        for key in ("predicted_text", "result"):
            if key in value:
                nested = normalize_text(value[key])
                if nested:
                    return nested
        return ""
    return str(value).strip()


def extract_score(value):
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 1.0
    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and isinstance(value[1], (int, float, str)):
            return extract_score(value[1])
    if isinstance(value, dict):
        for key in ("score", "confidence"):
            if key in value:
                return extract_score(value[key])
    return 1.0


def extract_polygon(value):
    if not value:
        return []
    if isinstance(value, dict):
        for key in ("points", "poly", "bbox", "box"):
            if key in value:
                return extract_polygon(value[key])
        return []
    if isinstance(value, (list, tuple)):
        if len(value) == 0:
            return []
        if isinstance(value[0], (list, tuple)) and len(value[0]) >= 2 and isinstance(value[0][0], (int, float)):
            return [tuple(float(inner) for inner in point[:2]) for point in value]
        if len(value) >= 2 and isinstance(value[1], (list, tuple)) and len(value[1]) >= 2:
            return extract_polygon(value[1])
    return []


def parse_candidate(item):
    if isinstance(item, dict):
        text = normalize_text(item)
        if not text:
            return None
        score = extract_score(item)
        polygon = extract_polygon(item)
        return {"text": text, "score": score, "polygon": polygon}

    if isinstance(item, (list, tuple)):
        if not item:
            return None

        if len(item) >= 2 and isinstance(item[0], (list, tuple)) and len(item[0]) >= 2:
            polygon = extract_polygon(item[0])
            text = normalize_text(item[1])
            if not text and len(item) >= 3:
                text = normalize_text(item[2])
            if text:
                return {"text": text, "score": extract_score(item[1]), "polygon": polygon}

        if len(item) >= 2 and isinstance(item[1], (list, tuple)) and len(item[1]) >= 2:
            polygon = extract_polygon(item[1])
            text = normalize_text(item[0])
            if text:
                return {"text": text, "score": extract_score(item[1]), "polygon": polygon}

        for child in item:
            parsed = parse_candidate(child)
            if parsed:
                return parsed

    if isinstance(item, str):
        text = item.strip()
        if text:
            return {"text": text, "score": 1.0, "polygon": []}

    return None


def traverse_payload(value):
    items = []

    def visit(node):
        if isinstance(node, (list, tuple)):
            candidate = parse_candidate(node)
            if candidate:
                items.append(candidate)
            for child in node:
                visit(child)
            return

        if isinstance(node, dict):
            candidate = parse_candidate(node)
            if candidate:
                items.append(candidate)
            for child in node.values():
                visit(child)
            return

    visit(value)
    return items


def get_field(value, name, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def as_list(value):
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def parse_structured_result(raw_result):
    pages = as_list(raw_result)
    parsed = []

    for page in pages:
        texts = get_field(page, "rec_texts")
        if texts is None:
            continue

        text_values = as_list(texts)
        score_values = as_list(get_field(page, "rec_scores", []))
        polygon_values = as_list(get_field(page, "dt_polys", []))
        box_values = as_list(get_field(page, "rec_boxes", []))

        for index, text_value in enumerate(text_values):
            text = normalize_text(text_value)
            if not text:
                continue

            polygon = polygon_values[index] if index < len(polygon_values) else []
            if hasattr(polygon, "tolist"):
                polygon = polygon.tolist()
            if polygon is None or len(polygon) == 0:
                polygon = []
            if len(polygon) == 0 and index < len(box_values):
                box = as_list(box_values[index])
                if len(box) >= 4:
                    left, top, right, bottom = [float(part) for part in box[:4]]
                    polygon = [[left, top], [right, top], [right, bottom], [left, bottom]]

            score = score_values[index] if index < len(score_values) else 1.0
            parsed.append({"text": text, "score": extract_score(score), "polygon": polygon})

    return parsed


def preprocess_image(image_path: Path, output_path: Path):
    with Image.open(image_path) as img:
        rgb = img.convert("RGB")
        rgb = ImageOps.autocontrast(rgb)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.8)
        rgb = ImageEnhance.Sharpness(rgb).enhance(2.0)
        scale = min(2.0, 3600 / max(rgb.width, rgb.height))
        if scale > 1:
            rgb = rgb.resize((round(rgb.width * scale), round(rgb.height * scale)), Image.Resampling.LANCZOS)
        rgb = rgb.filter(ImageFilter.SHARPEN)
        rgb = ImageOps.grayscale(rgb)
        rgb.save(output_path)


def parse_ocr_result(raw_result):
    words = []
    text_lines = []

    if not raw_result:
        return {"text": "", "words": words}

    structured_candidates = parse_structured_result(raw_result)
    if structured_candidates:
        candidates = structured_candidates
    else:
        candidates = []

    items = raw_result
    if isinstance(raw_result, dict):
        for key in ("res", "result", "data", "ocr_result"):
            if key in raw_result:
                items = raw_result[key]
                break
        else:
            items = raw_result.get("rec_texts", [])

    if isinstance(items, dict):
        items = items.get("rec_texts", items.get("result", []))

    if not candidates and isinstance(items, (list, tuple)):
        candidates = traverse_payload(items)

    if not candidates:
        text = normalize_text(raw_result)
        if text:
            return {"text": text, "words": [{"text": text, "confidence": 1.0, "bbox": {"x0": 0, "y0": 0, "x1": 0, "y1": 0}}]}
        return {"text": str(raw_result), "words": []}

    seen = set()
    for candidate in candidates:
        text = normalize_text(candidate.get("text", ""))
        if not text:
            continue
        if text in seen:
            continue
        seen.add(text)

        polygon = candidate.get("polygon") or []
        box_data = polygon_to_box(polygon)
        score = extract_score(candidate.get("score", 1.0))
        words.append({
            "text": text,
            "confidence": score,
            "bbox": {
                "x0": box_data["left"],
                "y0": box_data["top"],
                "x1": box_data["right"],
                "y1": box_data["bottom"],
            },
        })
        text_lines.append(text)

    return {"text": "\n".join(text_lines), "words": words}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: paddle_ocr.py IMAGE_PATH")

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        raise SystemExit(f"File not found: {image_path}")

    temp_path = image_path.with_suffix(".paddle-ocr.png")
    preprocess_image(image_path, temp_path)

    ocr = PaddleOCR(
        lang="ru",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )

    try:
        raw_result = ocr.predict(str(temp_path))
        parsed = parse_ocr_result(raw_result)
        print(json.dumps(parsed, ensure_ascii=False))
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
