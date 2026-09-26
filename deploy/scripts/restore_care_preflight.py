"""Offline, fail-closed preflight and isolation plan for one Care backup.

This module intentionally does not call Docker, start a container, restore a
database, or decrypt media.  A passing result means only that a complete,
immutable-looking backup can be selected for a separately authorized isolated
restore drill.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re

from care_backup_integrity import verify


RUN_PATTERN = re.compile(r"\A\d{8}T\d{6}Z-[0-9a-f]{8}\Z")
PROJECT_PATTERN = re.compile(r"\Acboard-care-[a-z0-9][a-z0-9_-]{0,49}\Z")
CONTAINER_ID_PATTERN = re.compile(r"\A[0-9a-f]{64}\Z")
IMAGE_ID_PATTERN = re.compile(r"\Asha256:[0-9a-f]{64}\Z")


class RestorePreflightError(RuntimeError):
    """The selected backup is not safe to present for an isolated drill."""


def _regular_directory(path, label):
    path = Path(path)
    if path.is_symlink() or not path.is_dir():
        raise RestorePreflightError(f"{label} must be a regular directory")
    for parent in path.parents:
        if parent.exists() and parent.is_symlink():
            raise RestorePreflightError(f"{label} parent must not be a symbolic link")
    return path.resolve(strict=True)


def _fixed_run(root, run, label):
    root = _regular_directory(root, label)
    candidate = root / run
    if candidate.is_symlink() or not candidate.is_dir():
        raise RestorePreflightError(f"{label} run is missing or symbolic")
    try:
        candidate.resolve(strict=True).relative_to(root)
    except ValueError as error:
        raise RestorePreflightError(f"{label} run escapes its fixed root") from error
    return candidate.resolve(strict=True)


def _regular_file(path, label):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise RestorePreflightError(f"{label} must be a regular file")
    return path


def _read_receipt(data_run):
    receipt_file = _regular_file(data_run / "receipt.json", "Backup receipt")
    try:
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RestorePreflightError("Backup receipt is unreadable") from error
    if not isinstance(receipt, dict):
        raise RestorePreflightError("Backup receipt must be an object")
    return receipt


def _validate_receipt(receipt, run, data_files, key_files):
    if receipt.get("createdAt") != run or receipt.get("scope") != "care":
        raise RestorePreflightError("Backup receipt run or scope is not accepted")
    project = receipt.get("project")
    if not isinstance(project, str) or not PROJECT_PATTERN.fullmatch(project):
        raise RestorePreflightError("Backup receipt project is not accepted")
    for field, pattern in (("apiContainerId", CONTAINER_ID_PATTERN),
                           ("mongoContainerId", CONTAINER_ID_PATTERN),
                           ("apiImageId", IMAGE_ID_PATTERN),
                           ("mongoImageId", IMAGE_ID_PATTERN)):
        if not isinstance(receipt.get(field), str) or not pattern.fullmatch(receipt[field]):
            raise RestorePreflightError(f"Backup receipt {field} is not accepted")
    if receipt.get("mediaVolume") != f"{project}_care_media":
        raise RestorePreflightError("Backup receipt media volume is not accepted")
    if receipt.get("integrityVersion") != 1:
        raise RestorePreflightError("Backup receipt integrity version is not accepted")
    if not isinstance(receipt.get("archiveBytes"), int) or receipt["archiveBytes"] <= 0:
        raise RestorePreflightError("Backup receipt archive size is not accepted")
    if receipt.get("dataFiles") != data_files or receipt.get("keyFiles") != key_files:
        raise RestorePreflightError("Backup receipt integrity counts do not match")
    if receipt.get("consistency") != "api-and-closure-quiesced":
        raise RestorePreflightError("Backup receipt consistency is not accepted")
    return project


def preflight_existing_run(data_root, key_root, run):
    """Validate one backup and return a non-executable isolated-drill plan."""
    if not isinstance(run, str) or not RUN_PATTERN.fullmatch(run):
        raise RestorePreflightError("run must match YYYYMMDDTHHMMSSZ-xxxxxxxx")
    data_root = _regular_directory(data_root, "Data backup root")
    key_root = _regular_directory(key_root, "Key backup root")
    if data_root == key_root or data_root in key_root.parents or key_root in data_root.parents:
        raise RestorePreflightError("Data and key backup roots must be separate")
    data_run = _fixed_run(data_root, run, "Data backup")
    key_run = _fixed_run(key_root, run, "Key backup")
    try:
        data_files = verify(data_run)
        key_files = verify(key_run)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RestorePreflightError("Backup integrity validation failed") from error
    if data_files <= 0 or key_files <= 0:
        raise RestorePreflightError("Backup integrity manifest is empty")
    receipt = _read_receipt(data_run)
    project = _validate_receipt(receipt, run, data_files, key_files)
    archive = _regular_file(data_run / "mongo.archive.gz", "Mongo archive")
    if archive.stat().st_size != receipt["archiveBytes"]:
        raise RestorePreflightError("Mongo archive size does not match receipt")
    media = _regular_directory(data_run / "media", "Care media")
    media_files = sum(1 for item in media.rglob("*") if item.is_file())
    _regular_file(key_run / "deployment.env", "Saved deployment environment")
    _regular_file(key_run / "care-mongo-key", "Saved Mongo key")
    return {
        "status": "preflight_passed_not_restored",
        "run": run,
        "project": project,
        "sourceReadOnly": True,
        "integrity": {"dataFiles": data_files, "keyFiles": key_files},
        "images": {"api": receipt["apiImageId"], "mongo": receipt["mongoImageId"]},
        "mediaVerification": (
            {"status": "planned", "encryptedFiles": media_files,
             "method": "decrypt restored profile media and compare each content digest"}
            if media_files else
            {"status": "not_applicable_no_media", "encryptedFiles": 0,
             "method": "no media was present in the accepted backup"}
        ),
        "isolationPlan": {
            "network": "none",
            "inputMountsReadOnly": True,
            "newOwnedContainersRequired": True,
            "database": "restore archive into a new Mongo container using the receipt Mongo digest",
            "media": (
                "decrypt restored profile media with the receipt API digest and compare each content digest"
                if media_files else "record that this accepted backup contains no media to decrypt or verify"
            ),
            "cleanup": "remove only containers carrying the unique restore-owner label",
        },
        "limitations": [
            "No Docker command was run.",
            "No database was restored.",
            "No key or media content was decrypted.",
            "This preflight does not satisfy the restore security review hold.",
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline Care backup restore preflight")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--key-root", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--dry-run", action="store_true", required=True,
                        help="required acknowledgement: this command only validates and plans")
    args = parser.parse_args(argv)
    print(json.dumps(preflight_existing_run(args.data_root, args.key_root, args.run), sort_keys=True))


if __name__ == "__main__":
    main()
