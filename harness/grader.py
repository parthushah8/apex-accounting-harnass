from __future__ import annotations

import re


def _numbers(text: str) -> list[float]:
    found = []
    for raw in re.findall(r"-?\(?\$?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?%?\)?", text):
        neg = raw.startswith("(") or raw.startswith("-")
        cleaned = raw.replace("$", "").replace(",", "").replace("%", "").replace("(", "").replace(")", "")
        try:
            val = float(cleaned)
        except ValueError:
            continue
        found.append(-val if neg and val > 0 else val)
    return found


def _acceptable(description: str) -> tuple[float, float] | None:
    m = re.search(
        r"acceptable (?:value|range) is \$?([0-9,]+\.?[0-9]*)%?(?: to \$?([0-9,]+\.?[0-9]*)%?)?",
        description,
        flags=re.I,
    )
    if not m:
        return None
    lo = float(m.group(1).replace(",", ""))
    hi = float(m.group(2).replace(",", "")) if m.group(2) else lo
    return lo, hi


def grade_answer(answer: str, rubric: list[dict]) -> dict:
    nums = _numbers(answer)
    results = []
    for item in rubric:
        desc = item["description"]
        bounds = _acceptable(desc)
        met = False
        matched = None
        if bounds:
            lo, hi = bounds
            for n in nums:
                if lo - 1e-9 <= n <= hi + 1e-9:
                    met = True
                    matched = n
                    break
        else:
            # qualitative: look for distinctive quoted phrases / names of 6+ chars
            tokens = re.findall(r"[A-Z][A-Za-z0-9&.'/-]{4,}(?:\s+[A-Z][A-Za-z0-9&.'/-]+)*", desc)
            hits = [t for t in tokens if t.lower() in answer.lower() and t.lower() not in {"account", "acceptable", "states"}]
            met = len(hits) >= 1
            matched = hits[0] if hits else None
        results.append(
            {
                "id": item["id"],
                "type": item.get("criterion_type"),
                "description": desc,
                "met": met,
                "matched": matched,
            }
        )
    passed = sum(1 for r in results if r["met"])
    total = len(results) or 1
    return {
        "passed": passed,
        "total": len(results),
        "score": passed / total,
        "criteria": results,
        "method": "numeric/phrase matcher — not the official DeepSeek judge",
    }
