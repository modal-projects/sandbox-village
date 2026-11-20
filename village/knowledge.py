"""What Mo knows, and the reading matter kept in his house.

Both come from Modal's own pages, read on Nov 12, 2026:

- `SANDBOX_NOTES`: a digest of the Sandbox guides (modal.com/docs/guide/sandboxes, -snapshots,
  -spawn, -networking, -files). It goes into Mo's instructions, so he answers from it without
  looking anything up, and onto his shelf as `sandboxes.md`.
- The GPU Glossary itself (modal.com/gpu-glossary): a copy of its source, `gpu_glossary/`, which
  is unpacked into his home as `gpu-glossary/` and lies open on his table (CC BY 4.0, see its
  NOTICE.md).

They are a snapshot of those pages, not a live copy. When the docs change, this file is what to
update. Prices are left out on purpose.
"""

from __future__ import annotations

import functools
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

SANDBOX_NOTES = """\
# Sandboxes, from Modal's docs

What they are
- A Sandbox is a secure container for running code you do not trust, such as code an AI model wrote.
- You make one with `modal.Sandbox.create(...)`, inside a Modal App. You get an ID back straight away.

Running things in one
- `sb.exec("python", "-c", "...")` runs a command inside a running Sandbox.
- It hands back the command's stdout, stderr and exit code. You can stream the output or read it all at once.
- Each command can have its own `timeout`. Output stays readable for 10 minutes after the command ends.

How long one lives
- By default a Sandbox lives at most 5 minutes. `timeout` raises that, up to 24 hours.
- `idle_timeout` ends one that has gone quiet: no command running, nothing written to stdin, no open tunnel connection.
- For anything longer than 24 hours: take a filesystem snapshot and start a new Sandbox from it.
- The stages are: created, scheduled, started, ready (only if it has a readiness probe), finished.
- `sb.terminate()` stops one. Its exit code is then 137.

Two runtimes
- gVisor: strong isolation, right for most work.
- `runtime="vm"`: the Sandbox gets its own Linux kernel, so Docker, FUSE mounts and nested cgroups work inside.
- GPU Sandboxes run on gVisor only.

Size
- You ask for `cpu` and `memory`. A Sandbox can burst above what it asked for when it needs to.

Snapshots
- Filesystem snapshot: `sb.snapshot_filesystem()` copies the whole disk and returns an Image. Only the files that changed from the base image are stored.
- Start a new Sandbox from that Image and everything is where it was. Many Sandboxes can start from one snapshot, each with its own copy.
- Snapshots are kept 30 days unless you set another `ttl`. Mounted Volumes are not part of a snapshot.
- Directory snapshot: `sb.snapshot_directory("/project")` saves one folder, and `sb.mount_image(path, image)` mounts it into a Sandbox that is already running.
- Memory snapshot (alpha): saves running processes too. It expires after 7 days.

Files
- `sb.filesystem` reads and writes files from outside: `write_text`, `read_text`, `copy_from_local`, `copy_to_local`, `list_files`, `remove`.
- It reads files up to 5 GB. For big data shared by many Sandboxes, mount a Volume.

Network
- By default a Sandbox can reach the public internet, and nothing can connect in to it.
- `block_network=True` cuts off all outbound traffic. `outbound_cidr_allowlist` allows only listed IP ranges; `outbound_domain_allowlist` allows only listed domains.
- To let the world in, open a port with `encrypted_ports` and read the address from `sb.tunnels()`.

Sidecars (beta)
- A sidecar is another container that runs beside the main one in the same Sandbox, with its own image and its own network rules.
- It can be started and stopped while the Sandbox runs, it stops when the Sandbox does, and the main container reaches it by its name.

Finding them again
- `Sandbox.from_id(id)` gets a running one back. A Sandbox can have a `name` (unique in its App) and up to 10 tags.

How this village uses all that
- Every house is one Sandbox with a quarter of a CPU and 512 MiB of memory, and may never use more than one core and 1 GiB.
- No house can reach the internet: each was created with an empty `outbound_cidr_allowlist`.
- Going to sleep is `snapshot_filesystem()` and then `terminate()`. Waking is `Sandbox.create` from that snapshot's Image.
- Dot's house uses `runtime="vm"`. The games console behind the screens is a sidecar.
- Who is awake, and each house's latest snapshot, are written in the village register, a Modal Dict.
"""

# ---- the GPU Glossary: the real one, as files -----------------------------------------------------

GLOSSARY_DIR = Path(__file__).with_name("gpu_glossary")  # a copy of modal-labs/gpu-glossary (CC BY 4.0); see its NOTICE.md
GLOSSARY_HOME = "gpu-glossary"  # the folder it becomes in Mo's home

# The order the pages have in the published glossary. Pages not listed go at the end of their section.
_GLOSSARY_ORDER = {
    "device-hardware": "cuda-device-architecture streaming-multiprocessor core special-function-unit load-store-unit warp-scheduler cuda-core tensor-core "
    "tensor-memory-accelerator streaming-multiprocessor-architecture texture-processing-cluster graphics-processing-cluster register-file l1-data-cache "
    "tensor-memory gpu-ram",
    "device-software": "cuda-programming-model streaming-assembler parallel-thread-execution compute-capability thread warp warpgroup cooperative-thread-array "
    "kernel thread-block thread-block-grid thread-hierarchy memory-hierarchy registers shared-memory global-memory cuda-tile-programming-model",
    "host-software": "cuda-software-platform cuda-c nvidia-gpu-drivers nvidia-ko cuda-driver-api libcuda nvml libnvml nvidia-smi cuda-runtime-api libcudart "
    "cuda-graph nvcc nvrtc cupti nsight-systems cuda-binary-utilities cublas cudnn cutlass cute cute-dsl",
    "perf": "performance-bottleneck roofline-model compute-bound memory-bound arithmetic-intensity overhead littles-law memory-bandwidth arithmetic-bandwidth "
    "latency-hiding warp-execution-state active-cycle occupancy pipe-utilization peak-rate issue-efficiency streaming-multiprocessor-utilization "
    "warp-divergence scoreboard-stall branch-efficiency memory-coalescing bank-conflict register-pressure",
}


def _front(text: str) -> tuple[str, str]:
    """(title, body) of a glossary page: the title comes from its front matter."""
    title = ""
    if text.startswith("---"):
        head, _, text = text[3:].partition("\n---")
        found = re.search(r"^title:\s*(.+)$", head, re.M)
        title = found.group(1).strip().strip('"') if found else ""
    return title, text.lstrip("\n")


def _short(title: str) -> str:
    """'What is a Warp?' -> 'Warp': the name a table of contents wants."""
    name = re.sub(r"^What (?:is|are|does it mean to be)\s+(?:(?:a|an|the)\s+)?", "", title.rstrip("?")).strip()
    return name[:1].upper() + name[1:] if name else title


def glossary_index() -> list[dict]:
    """The table of contents: sections in order, each with its pages in order."""
    sections = []
    for key, order in _GLOSSARY_ORDER.items():
        title, intro = _front((GLOSSARY_DIR / f"{key}.md").read_text())
        wanted = order.split()
        slugs = sorted((path.stem for path in (GLOSSARY_DIR / key).glob("*.md")), key=lambda slug: (wanted.index(slug) if slug in wanted else len(wanted), slug))
        pages = []
        for slug in slugs:
            page_title, _ = _front((GLOSSARY_DIR / key / f"{slug}.md").read_text())
            pages.append({"path": f"{GLOSSARY_HOME}/{key}/{slug}.md", "title": page_title, "name": _short(page_title)})
        sections.append({"key": key, "title": title, "intro": " ".join(intro.split()), "path": f"{GLOSSARY_HOME}/{key}.md", "pages": pages})
    return sections


@functools.lru_cache(maxsize=1)
def glossary_archive() -> tuple[str, bytes]:
    """(version, tar.gz) of the glossary as it goes into a home: every page, the licence and
    notice, the generated index.json, and a .version file the home is checked against."""
    files = {str(path.relative_to(GLOSSARY_DIR)): path.read_bytes() for path in sorted(GLOSSARY_DIR.rglob("*")) if path.is_file()}
    files["index.json"] = json.dumps(glossary_index(), indent=1).encode()
    digest = hashlib.sha1()
    for name, data in sorted(files.items()):
        digest.update(name.encode() + b"\0" + data)
    version = digest.hexdigest()[:12]
    files[".version"] = version.encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(f"{GLOSSARY_HOME}/{name}")
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return version, buffer.getvalue()


ARCHIVES = {GLOSSARY_HOME: glossary_archive}  # folder in the home -> what fills it

# What Mo is told. The notes above, and how to use them.
MO_LORE = (
    "What you know about Modal Sandboxes, from Modal's documentation. Answer questions about sandboxes, snapshots and "
    "the village's workings from these notes, in your own plain words. Give the one fact that answers the question, "
    "not a list. For these answers you may use two sentences, up to 35 words. If the notes do not cover it, say you "
    "would have to check the docs at modal.com/docs. Never talk about prices. You know these notes by heart: do not "
    "use a tool to look them up, just answer, once.\n\n" + SANDBOX_NOTES + "\n"
    "GPUs are different: you do not know those by heart. The whole of Modal's GPU Glossary is in your home, in "
    "gpu-glossary/, one page per term, in the folders device-hardware, device-software, host-software and perf "
    "(for example gpu-glossary/device-software/warp.md). For a question about a GPU term, read the start of its page "
    "with one command, such as: head -c 900 gpu-glossary/device-software/warp.md  (use ls gpu-glossary/* if you are "
    "not sure of the file name). Then answer once, in two sentences."
)
