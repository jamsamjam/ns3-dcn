from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import subprocess


class RunRequest(BaseModel):
    k: int = 4
    linkRate: str = "10Mbps"
    linkDelay: str = "1ms"
    tcp: str = "ns3::TcpNewReno"


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


def build_run_tag(req: RunRequest) -> str:
    tcp_variant = req.tcp.split("::")[-1]
    return f"k{req.k}_d{req.linkDelay}_r{req.linkRate}_tcp{tcp_variant}"


def get_link_ids(run_tag: str) -> list[str]:
    run_dir = output_path / run_tag
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")

    csv_files = sorted(run_dir.glob("packets_*.csv"))
    return [f.stem.replace("packets_", "") for f in csv_files]


@app.post("/run")
def run(req: RunRequest):
    run_tag = build_run_tag(req)
    run_dir = output_path / run_tag

    if not run_dir.exists():
        args = [
            "./ns3", "run", "scratch/DCN", "--",
            f"--k={req.k}",
            f"--linkRate={req.linkRate}",
            f"--linkDelay={req.linkDelay}",
            f"--tcp={req.tcp}",
        ]

        try:
            subprocess.run(args, cwd=ns3_path, check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"ns-3 run failed: {e}")

    link_ids = get_link_ids(run_tag)
    return {
        "runTag": run_tag,
        "linkIds": link_ids,
    }


@app.get("/results/{run_tag}")
def get_run_results(run_tag: str):
    link_ids = get_link_ids(run_tag)
    return {"runTag": run_tag, "linkIds": link_ids}