# server.py
from flask import Flask, request, jsonify
import subprocess
import os
import json
from datetime import datetime

# >>> import module Drive đã tách
from google_drive_service import upload_to_drive, upload_to_drive_advanced


from rq import Queue
from redis import Redis
from rq.job import Job

from tasks import process_design_job  # task đã viết trong worker
from rq import Retry   # ✅ thêm import

import re
import tempfile
import requests
from urllib.parse import urlparse

# Kết nối Redis (đổi host/password theo setup của bạn)
# KẾT NỐI KHÔNG MẬT KHẨU
redis_conn = Redis(host="127.0.0.1", port=6379, password=None)
q = Queue("design", connection=redis_conn, default_timeout=900)  # 15'

SCOPES = ['https://www.googleapis.com/auth/drive.file']
FOLDER_ID = "1vxaF4JhdHq33w00zBRpYgCqIVeIpYYkX"  # Thư mục Drive gốc

app = Flask(__name__)

def _sanitize_folder_name(name: str) -> str:
    # Loại ký tự không hợp lệ cho tên Drive/folder
    # (giữ lại chữ, số, '-', '_', '.', ' ')
    name = re.sub(r'[^0-9A-Za-z\-\._ ]+', '_', str(name))
    # tránh tên rỗng
    return name or "order"


@app.route("/generate", methods=["POST"])
def generate_design():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON body received"}), 400

        order_id = data.get("order_id")
        psd_filename = data.get("template")  # tên file psd
        actions = data.get("actions")
        main_image_url = (data.get("main_image_url") or "").strip()


        if not order_id or not psd_filename or not isinstance(actions, list):
            return jsonify({
                "status": "error",
                "message": "Invalid payload: thiếu order_id, template hoặc actions."
            }), 400
        
        order_folder_name = _sanitize_folder_name(order_id)
        downloaded_mockup_path = None


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
            except Exception as e:
                print("[WARN] Cannot read/parse report JSON:", e)

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
        
        # Nếu có main_image_url -> tải mockup về (safe timeout)
        if main_image_url:
            try:
                # Lấy tên file từ URL (nếu có phần mở rộng)
                parsed = urlparse(main_image_url)
                base = os.path.basename(parsed.path) or "mockup.jpg"
                # đảm bảo có .jpg/.jpeg/.png; nếu không thì gán .jpg
                if not re.search(r'\.(jpe?g|png)$', base, re.IGNORECASE):
                    base = "mockup.jpg"

                # tải về thư mục tạm
                tmpdir = tempfile.gettempdir()
                downloaded_mockup_path = os.path.join(tmpdir, f"{order_folder_name}__{base}")

                r = requests.get(main_image_url, timeout=20)
                r.raise_for_status()
                with open(downloaded_mockup_path, "wb") as f:
                    f.write(r.content)

                print(f"[MOCKUP] Downloaded to: {downloaded_mockup_path}")
            except Exception as de:
                print(f"[MOCKUP][WARN] Cannot download mockup from URL: {main_image_url} -> {de}")
                downloaded_mockup_path = None


        # 👉 Gọi hàm upload của module đã tách
        if not main_image_url:
            # === Giữ NGUYÊN hành vi cũ ===
            drive_link = upload_to_drive(
                output_path,
                output_filename,
                parent_folder_id=FOLDER_ID,
                use_date_subfolder=True,
            )
            return jsonify({
                "status": "success",
                "message": "PSD processed successfully",
                "outputPath": drive_link,
                "report": report_data or {}
            })
        else:
            # === Hành vi MỚI khi có main_image_url ===
            # Upload ảnh PTS và mockup (nếu tải được) vào: /<DATE>/<ORDER_ID>/
            upload_info = {}

            up1 = upload_to_drive_advanced(
                file_path=output_path,
                filename=output_filename,
                parent_folder_id=FOLDER_ID,
                use_date_subfolder=True,
                order_subfolder=order_folder_name,
                make_public_link=False,  # giữ nguyên phạm vi theo token
                return_folder_link=True, # trả thêm link folder
            )
            upload_info["design_link"] = up1["webViewLink"]
            upload_info["folder_link"] = up1.get("folderWebLink")

            if downloaded_mockup_path and os.path.exists(downloaded_mockup_path):
                mockup_name = os.path.basename(downloaded_mockup_path)
                up2 = upload_to_drive_advanced(
                    file_path=downloaded_mockup_path,
                    filename=mockup_name,
                    parent_folder_id=FOLDER_ID,
                    use_date_subfolder=True,
                    order_subfolder=order_folder_name,
                    make_public_link=False,
                    # không cần lấy lại folder_link lần 2
                )
                upload_info["mockup_link"] = up2["webViewLink"]
            else:
                upload_info["mockup_link"] = None

            return jsonify({
                "status": "success",
                "message": "PSD processed successfully",
                "outputPath": upload_info["design_link"],
                "mockupPath": upload_info["mockup_link"],
                "folderPath": upload_info["folder_link"],
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
