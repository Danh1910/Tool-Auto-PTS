# enqueue_api.py
from flask import Flask, request, jsonify
from rq import Queue
from redis import Redis
import os, json

from tasks import process_design_job

# Redis connection (bảo mật: password, host cố định)
redis_conn = Redis(host="REDIS_HOST", port=6379, password="REDIS_PASSWORD", decode_responses=True)
q = Queue("design", connection=redis_conn, default_timeout=900)  # 15'

app = Flask(__name__)

@app.post("/jobs")
def create_job():
    data = request.get_json() or {}
    # Idempotency: cho phép client gửi order_id để tránh enqueue trùng
    client_job_key = data.get("order_id")
    # (tuỳ chọn) kiểm tra trùng bằng Redis SETNX với TTL

    job = q.enqueue(process_design_job, data, job_timeout=900, retry=3)  # retry 3 lần
    return jsonify({"job_id": job.get_id()}), 202

@app.get("/jobs/<job_id>")
def get_job(job_id):
    from rq.job import Job
    try:
        job = Job.fetch(job_id, connection=redis_conn)
    except Exception:
        return jsonify({"error":"Job not found"}), 404

    status_map = {
        "queued": "queued",
        "started": "running",
        "deferred": "queued",
        "finished": "finished",
        "failed": "failed"
    }
    state = status_map.get(job.get_status(), job.get_status())
    resp = {
        "job_id": job_id,
        "state": state,
        "meta": job.meta or {}
    }
    if state == "finished":
        resp["result"] = job.result  # {"status":"success"/"error", ...}
    elif state == "failed":
        resp["error"] = getattr(job, "exc_info", None)
    return jsonify(resp), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002)
