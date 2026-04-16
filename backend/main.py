import json
import threading
import uuid
from pathlib import Path
from typing import List

import subprocess

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ns3_path = Path("../ns3").resolve()
output_path = Path("./output").resolve()
output_path.mkdir(exist_ok=True)

app.mount("/output", StaticFiles(directory=output_path), name="output")

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


class RunRequest(BaseModel):
    config: str = "scratch/config/simple-topology.json"
    queueSize: int = 100
    rate: str = "5Mbps"
    tcp: str = "ns3::TcpNewReno"
    linkRates: List[str] = []
    time: float = 10.0


@app.post("/run")
def run(req: RunRequest):
    job_id = str(uuid.uuid4())

    with jobs_lock:
        jobs[job_id] = {"status": "running"}

    def do_run():
        try:
            args = [
                "./ns3", "run", "simple", "--",
                f"--config={req.config}",
                f"--queueSize={req.queueSize}p",
                f"--rate={req.rate}",
                f"--tcp={req.tcp}",
                f"--time={req.time}",
            ]
            if req.linkRates:
                args.append(f"--linkRates={','.join(req.linkRates)}")

            subprocess.run(args, cwd=ns3_path, check=True)

            with jobs_lock:
                jobs[job_id]["status"] = "done"
        except subprocess.CalledProcessError as e:
            with jobs_lock:
                jobs[job_id]["status"] = "error"
                jobs[job_id]["error"] = str(e)

    threading.Thread(target=do_run, daemon=True).start()
    return {"jobId": job_id}


@app.get("/status/{job_id}")
def get_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return {"status": "not_found"}
    return job


@app.get("/results")
def get_results():
    csv_files = sorted(output_path.glob("packets_*.csv"))
    link_ids = [f.stem.replace("packets_", "") for f in csv_files]

    topology = None
    config_path = ns3_path / "scratch/config/simple-topology.json"
    if config_path.exists():
        topology = json.loads(config_path.read_text())

    return {"linkIds": link_ids, "topology": topology}
