# server.py
from flask import Flask, request, jsonify
import subprocess
import os
import json
from datetime import datetime

# >>> import module Drive đã tách
from google_drive_service import upload_to_drive

from rq import Queue
from redis import Redis
from rq.job import Job

from tasks import process_design_job  # task đã viết trong worker
from rq import Retry   # ✅ thêm import


# Kết nối Redis (đổi host/password theo setup của bạn)
# KẾT NỐI KHÔNG MẬT KHẨU
redis_conn = Redis(host="127.0.0.1", port=6379, password=None)
q = Queue("design", connection=redis_conn, default_timeout=900)  # 15'

SCOPES = ['https://www.googleapis.com/auth/drive.file']
FOLDER_ID = "1vxaF4JhdHq33w00zBRpYgCqIVeIpYYkX"  # Thư mục Drive gốc

app = Flask(__name__)

@app.route("/generate", methods=["POST"])
def generate_design():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON body received"}), 400

        order_id = data.get("order_id")
        psd_filename = data.get("template")  # tên file psd
        actions = data.get("actions")

        if not order_id or not psd_filename or not isinstance(actions, list):
            return jsonify({
                "status": "error",
                "message": "Invalid payload: thiếu order_id, template hoặc actions."
            }), 400

        # --- Các giá trị cố định ---
        psd_folder = r"C:\Users\MSI\Design_PSD"
        output_folder = os.path.join(psd_folder, "Image_output")
        psd_full_path = os.path.join(psd_folder, psd_filename)
        output_filename = f"{order_id}.jpg"
        jpg_quality = 12

        final_payload = {
            "psdFilePath": psd_full_path,
            "outputFolder": output_folder,
            "outputFilename": output_filename,
            "jpgQuality": jpg_quality,
            "actions": actions
        }

        # Tên file tạm cơ bản (giữ nguyên như code cũ)
        config_path = os.path.join(os.getcwd(), "psd_config.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(final_payload, f, indent=2, ensure_ascii=False)

        result_path = os.path.join(os.getcwd(), "psd_result.json")
        log_path    = os.path.join(os.getcwd(), f"psd_result_{order_id}_debug.log")

        print(f"[INFO] Config saved to: {config_path}")
        print(f"[INFO] Report JSON will be at: {result_path}")
        print(f"[INFO] Payload sent to Photoshop:\n{json.dumps(final_payload, indent=2, ensure_ascii=False)}")

        cmd = ["py", "run_ps_script.py", config_path, result_path, log_path]
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            print("[ERROR] Photoshop script failed:")
            print(result.stderr or result.stdout)
            return jsonify({
                "status": "error",
                "message": "Photoshop script failed",
                "details": result.stderr or result.stdout
            }), 500

        output_path = os.path.join(output_folder, output_filename)
        print(f"[SUCCESS] Generated image: {output_path}")

        report_data = None
        if os.path.exists(result_path):
            try:
                with open(result_path, "r", encoding="utf-8") as rf:
                    report_data = json.load(rf)
            except Exception as re:
                print("[WARN] Cannot read/parse report JSON:", re)

        def _has_missing(report: dict) -> bool:
            if not isinstance(report, dict):
                return False
            keys = (
                "missingGroupPaths",
                "missingPaths",
                "missingTextTargets",
                "missingShowLayers",
                "configErrors",
            )
            return any(report.get(k) for k in keys)

        has_config_error = bool(report_data and report_data.get("configErrors"))
        has_missing = _has_missing(report_data)

        if has_config_error:
            return jsonify({
                "status": "error",
                "message": "Config error: PSD file not found or invalid psdFilePath",
                "report": report_data or {},
                "outputLocalPath": output_path if os.path.exists(output_path) else None
            }), 200

        if has_missing:
            return jsonify({
                "status": "error",
                "message": "PSD processed with missing targets (skip upload)",
                "report": report_data or {},
                "outputLocalPath": output_path if os.path.exists(output_path) else None
            }), 200

        if not os.path.exists(output_path):
            return jsonify({
                "status": "error",
                "message": "Output image not found (export may have failed)",
                "report": report_data or {}
            }), 200

        # 👉 Gọi hàm upload của module đã tách
        drive_link = upload_to_drive(
            output_path,
            output_filename,
            parent_folder_id=FOLDER_ID,
            use_date_subfolder=True,
            # token_path="token.json",           # có thể truyền path tuỳ biến
            # credentials_path="credentials.json"
        )

        return jsonify({
            "status": "success",
            "message": "PSD processed successfully",
            "outputPath": drive_link,
            "report": report_data or {}
        })

    except Exception as e:
        print(f"[EXCEPTION] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# ---- thêm ngay dưới route /generate hoặc trên cũng được ----
@app.post("/jobs")
def create_job():
    data = request.get_json() or {}
    job = q.enqueue(
        process_design_job,
        data,
        job_timeout=900,
        retry=Retry(max=3, interval=[5, 15, 30])  # ✅ thay vì retry=3
    )
    return jsonify({"job_id": job.get_id()}), 202

@app.get("/jobs/<job_id>")
def get_job(job_id):
    try:
        job = Job.fetch(job_id, connection=redis_conn)
    except Exception:
        return jsonify({"error": "Job not found"}), 404

    status_map = {"queued":"queued","started":"running","deferred":"queued","finished":"finished","failed":"failed"}
    state = status_map.get(job.get_status(), job.get_status())

    resp = {"job_id": job_id, "state": state, "meta": job.meta or {}}
    if state == "finished":
        resp["result"] = job.result  # dict {"status":"success"/"error", ...}
    elif state == "failed":
        resp["error"] = getattr(job, "exc_info", None)
    return jsonify(resp), 200


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000)
