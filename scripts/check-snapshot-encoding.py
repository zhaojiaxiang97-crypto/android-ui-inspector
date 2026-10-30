"""Read-only same-bitmap RGBA/PNG/WebP comparison. Requires Pillow; no pixel tolerance."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image


def differences(reference, actual):
    if len(reference) != len(actual) or len(reference) % 4:
        raise ValueError("RGBA byte length mismatch")
    result = dict(pixels=0, alpha=0, opaque=0, maxStraight=0, maxPremultiplied=0)
    for offset in range(0, len(reference), 4):
        a, b = reference[offset:offset + 4], actual[offset:offset + 4]
        if a == b:
            continue
        result["pixels"] += 1
        result["alpha"] += a[3] != b[3]
        result["opaque"] += a[3] == b[3] == 255
        result["maxStraight"] = max(result["maxStraight"], *(abs(x - y) for x, y in zip(a, b)))
        # Diagnostic only: exact straight RGBA equality remains the gate.
        result["maxPremultiplied"] = max(result["maxPremultiplied"], abs(a[3] - b[3]),
            *(abs((a[i] * a[3] + 127) // 255 - (b[i] * b[3] + 127) // 255) for i in range(3)))
    return result


def main(directory):
    path = Path(directory)
    report = json.loads((path / "report.json").read_text())
    if report.get("passed") is not True or len(report.get("cases", [])) != 9:
        raise ValueError("Incomplete device probe")
    results = []
    for case in report["cases"]:
        name = case["name"]
        if name not in [f"{kind}-{round}" for kind in ["text", "software", "palette"] for round in range(3)]:
            raise ValueError("Unexpected case")
        raw = (path / f"{name}.rgba").read_bytes()
        if len(raw) != case["width"] * case["height"] * 4 or hashlib.sha256(raw).hexdigest() != case["sha256"]:
            raise ValueError("Raw pixel size/digest mismatch")
        decoded = {}
        for format in ["png", "webp"]:
            with Image.open(path / f"{name}.{format}") as image:
                if image.size != (case["width"], case["height"]):
                    raise ValueError("Encoded dimensions mismatch")
                decoded[format] = image.convert("RGBA").tobytes()
        results.append(dict(name=name, rawSha=case["sha256"],
            pngVsRaw=differences(raw, decoded["png"]), webpVsRaw=differences(raw, decoded["webp"]),
            pngVsWebp=differences(decoded["png"], decoded["webp"])))
    raw_draw = differences((path / "text-0.rgba").read_bytes(), (path / "software-0.rgba").read_bytes())
    print(json.dumps(dict(hardware=report["hardware"], hardwareVsSoftware=raw_draw, results=results), indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
