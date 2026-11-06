import argparse
import json
from pathlib import Path

from .core import MAX_UPLOAD_BYTES, SearchService


def main():
    parser = argparse.ArgumentParser(description="Import images into the vector index")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--recursive", action="store_true")
    args = parser.parse_args()
    if not args.folder.is_dir():
        parser.error("folder must exist")
    service = SearchService()
    files = args.folder.rglob("*") if args.recursive else args.folder.glob("*")
    count = errors = duplicates = 0
    for path in files:
        if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        try:
            if path.stat().st_size > MAX_UPLOAD_BYTES:
                raise ValueError("over 20 MB")
            result = service.add(path.read_bytes(), path.name)
            duplicates += int(result["duplicate"])
            count += 1
        except (ValueError, OSError) as exc:
            errors += 1
            print(json.dumps({"file": str(path), "error": str(exc)}))
    print(json.dumps({"processed": count, "duplicates": duplicates, "errors": errors}))


if __name__ == "__main__":
    main()
