from __future__ import annotations

import os
from pathlib import Path

from .config import APPS_DATA, TASK_FILES, WORLD_FS


def mount_workspace(dest: Path, slug: str) -> list[dict]:
    dest.mkdir(parents=True, exist_ok=True)
    linked: list[dict] = []

    def link(src: Path, rel: Path, origin: str) -> None:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            return
        os.symlink(src, target)
        linked.append(
            {
                "path": str(rel).replace("\\", "/"),
                "origin": origin,
                "bytes": src.stat().st_size if src.is_file() else 0,
                "dir": src.is_dir(),
            }
        )

    for src in WORLD_FS.rglob("*"):
        if src.is_file() and ".cache" not in src.parts:
            link(src, src.relative_to(WORLD_FS), "world/filesystem")

    if APPS_DATA.exists():
        for src in APPS_DATA.rglob("*"):
            if src.is_file():
                rel = Path(src.name)
                if (dest / rel).exists():
                    rel = Path("apps") / src.name
                link(src, rel, "world/apps_data/quickbooks")

    extra = TASK_FILES / slug
    if extra.exists():
        for src in extra.rglob("*"):
            if src.is_file():
                link(src, Path(src.name), f"task_files/{slug}")

    return sorted(linked, key=lambda x: x["path"])


def file_tree(files: list[dict]) -> list[dict]:
    return files
