# tasks.py
import os, sys, json, subprocess, traceback, time, re, tempfile
from datetime import datetime
from rq import get_current_job
from urllib.parse import urlparse
import urllib.request
import urllib.error
import urllib.parse
import requests

from google_drive_service import upload_to_drive, upload_to_drive_advanced  # advanced uploader

# --- Cấu hình local ---
PSD_FOLDER    = r"C:\Users\MSI\Design_PSD"
OUTPUT_FOLDER = os.path.join(PSD_FOLDER, "Image_output")
FOLDER_ID     = "1vxaF4JhdHq33w00zBRpYgCqIVeIpYYkX"

# --- Callback hardcode (KHÔNG cần PHP truyền) ---
DEFAULT_CALLBACK_URL = "https://bkteam.top/dungvuong-admin/api/design_callback.php?token=REPLACE_WITH_RANDOM_SECRET"

# =========================
# Helpers (job/meta/log)
# =========================
def _get_job():
    try:
        return get_current_job()
    except Exception:
        return None

def _append_meta_log(job, msg: str):
    try:
        logs = job.meta.get("logs") or []
        logs.append(msg)
        job.meta["logs"] = logs
        job.save_meta()
    except Exception:
        pass

def _log(msg: str):
    """In ra console + đẩy vào job.meta['logs'] (nếu có job)."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    job = _get_job()
    if job:
        _append_meta_log(job, line)

def _split_item_id(order_id: str):
    """order_id dạng 'ORD123_456' -> 456 (int). Nếu không tách được -> None"""
    try:
        tail = str(order_id).rsplit('_', 1)[-1]
        return int(tail)
    except Exception:
        return None

def _sanitize_folder_name(name: str) -> str:
    # chỉ cho phép chữ/số, '-', '_', '.', ' '
    name = re.sub(r'[^0-9A-Za-z\-\._ ]+', '_', str(name))
    return name or "order"

# =========================
# HTTP callback
# =========================
def _post_json(url: str, payload: dict, timeout=10, headers=None):
    try:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        h = {'Content-Type': 'application/json'}
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, data=data, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return True, resp.read().decode('utf-8', errors='ignore')
    except Exception as e:
        _log(f"[WARN] Callback failed: {e}")
        return False, str(e)

def _post_json_with_retry(url: str, payload: dict, tries=3, delay=2):
    last = None
    for _ in range(tries):
        ok, resp = _post_json(url, payload, timeout=10)
        if ok:
            return True, resp
        last = resp
        time.sleep(delay)
    return False, last

# =========================
# Photoshop runner (render only)
# =========================
def _run_photoshop(order_id: str, psd_filename: str, actions: list, output_format: str = "jpg"):
    job = _get_job()
    job_id = job.get_id() if job else order_id

    # chuẩn hoá format
    fmt = (output_format or "jpg").strip().lower()
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt not in ("jpg", "png"):
        fmt = "jpg"

    psd_full_path = os.path.join(PSD_FOLDER, psd_filename)

    # đặt tên file theo format
    if fmt == "png":
        output_filename = f"{order_id}.png"
    else:
        output_filename = f"{order_id}.jpg"

    jpg_quality = 12  # chỉ dùng cho jpg

    # payload cho JSX
    final_payload = {
        "psdFilePath": psd_full_path,
        "outputFolder": OUTPUT_FOLDER,
        "outputFilename": output_filename,
        "outputFormat": fmt,     # <<< quan trọng: match với JSX bạn vừa sửa
        "actions": actions
    }
    if fmt == "jpg":
        final_payload["jpgQuality"] = jpg_quality

    # file tạm (dùng tên cố định hoặc tùy bạn nhân bản theo job_id)
    cwd         = os.getcwd()
    config_path = os.path.join(cwd, "psd_config.json")
    result_path = os.path.join(cwd, "psd_result.json")
    log_path    = os.path.join(cwd, "psd_result.log")

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(final_payload, f, indent=2, ensure_ascii=False)

    _log(f"Config saved to: {config_path}")
    _log(f"Report JSON will be at: {result_path}")
    _log("Payload sent to Photoshop:\n" + json.dumps(final_payload, indent=2, ensure_ascii=False))

    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "run_ps_script.py"))
    python_exe  = sys.executable or "py"
    cmd = [python_exe, script_path, config_path, result_path, log_path]

    _log(f"Executing: {cmd!r}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except Exception as ex:
        _log(f"[ERROR] Failed to start Photoshop runner: {ex}")
        raise

    if res.stdout:
        _log("[STDOUT]\n" + res.stdout.strip())
    if res.stderr:
        _log("[STDERR]\n" + res.stderr.strip())

    if res.returncode != 0:
        _log("[ERROR] Photoshop script failed (non-zero exit).")
        raise RuntimeError(res.stderr or res.stdout or "Photoshop script failed")

    # đường dẫn đúng với tên file vừa đặt
    output_path = os.path.join(OUTPUT_FOLDER, output_filename)
    _log(f"[SUCCESS] Generated image: {output_path}")

    # đọc report như cũ ...
    report_data = None
    if os.path.exists(result_path):
        try:
            with open(result_path, "r", encoding="utf-8") as rf:
                report_data = json.load(rf)
        except Exception as e:
            _log(f"[WARN] Cannot read/parse report JSON: {e}")

    def _has_missing(report: dict) -> bool:
        if not isinstance(report, dict):
            return False
        keys = ("missingGroupPaths","missingPaths","missingTextTargets","missingShowLayers","configErrors")
        return any(report.get(k) for k in keys)

    has_config_error = bool(report_data and report_data.get("configErrors"))
    has_missing      = _has_missing(report_data)

    if has_config_error:
        _log("[ERROR] Config error in report: PSD file not found or invalid psdFilePath.")
        return {
            "status":"error",
            "message":"Config error: PSD file not found or invalid psdFilePath",
            "report": report_data or {},
            "outputLocalPath": output_path if os.path.exists(output_path) else None
        }

    if has_missing:
        _log("[ERROR] PSD processed with missing targets -> skip upload.")
        return {
            "status":"error",
            "message":"PSD processed with missing targets (skip upload)",
            "report": report_data or {},
            "outputLocalPath": output_path if os.path.exists(output_path) else None
        }

    if not os.path.exists(output_path):
        _log("[ERROR] Output image not found (export may have failed).")
        return {
            "status":"error",
            "message":"Output image not found (export may have failed)",
            "report": report_data or {}
        }

    return {
        "status":"success",
        "message":"PSD processed successfully",
        "outputLocalPath": output_path,
        "report": report_data or {},
        "format": fmt        # <<< để tầng trên biết file ra là gì
    }


# =========================
# Task chính (được enqueue)
# =========================
def process_design_job(payload: dict):
    """
    payload: {
      "order_id": "...",
      "template": "xxx.psd",
      "actions":[...],
      "main_image_url": "https://..."   # optional
    }
    -> Khi xong sẽ tự callback về PHP theo DEFAULT_CALLBACK_URL (hardcode).
    """
    job = _get_job()
    if job:
        job.meta["progress"] = "queued"
        job.save_meta()

    order_id = payload.get("order_id")
    psd_file = payload.get("template")
    actions  = payload.get("actions", [])
    main_image_url = (payload.get("main_image_url") or "").strip()
    output_format = (payload.get("output_format") or "jpg").strip().lower()   # <<< NEW

    # chỉ lấy phần trước dấu "_" để đặt tên thư mục
    pure_order = str(order_id).split("_", 1)[0] if order_id else "order"
    order_folder_name = _sanitize_folder_name(pure_order)

    if not order_id or not psd_file or not isinstance(actions, list):
        _log("[ERROR] Invalid payload for process_design_job.")
        _callback(order_id, status="error", drive_url=None, message="Invalid payload", report=None)
        return {"status":"error","message":"Invalid payload"}

    _log(f"Start process_design_job | job_id={job.get_id() if job else 'N/A'} | order_id={order_id} | template={psd_file}")
    if job:
        job.meta["progress"] = "running"
        job.save_meta()

    try:
        # truyền format xuống
        result = _run_photoshop(order_id, psd_file, actions, output_format=output_format)
        
        status = result.get("status")
        report = result.get("report") or {}
        local_path = result.get("outputLocalPath")

        if status != "success" or not local_path or not os.path.exists(local_path):
            if job:
                job.meta["progress"] = "failed"
                job.save_meta()
            _callback(order_id, status=status or "error", drive_url=None, message=result.get("message"), report=report)
            return result

        # ==== UPLOAD THEO 2 NHÁNH ====
        upload_info = {"design_link": None, "mockup_link": None, "folder_link": None}

        if not main_image_url:
            # === Hành vi CŨ: upload 1 file vào /DATE/ ===
            drive_link = upload_to_drive(
                local_path,
                os.path.basename(local_path),
                parent_folder_id=FOLDER_ID,
                use_date_subfolder=True
            )
            upload_info["design_link"] = drive_link
        else:
            # === Hành vi MỚI: tạo /DATE/<order_id>/ và up cả 2 file ===
            # 1) upload ảnh PTS
            up1 = upload_to_drive_advanced(
                file_path=local_path,
                filename=os.path.basename(local_path),
                parent_folder_id=FOLDER_ID,
                use_date_subfolder=True,
                order_subfolder=order_folder_name,
                make_public_link=False,
                return_folder_link=True,
            )
            upload_info["design_link"] = up1["webViewLink"]
            upload_info["folder_link"] = up1.get("folderWebLink")

            # 2) tải mockup và upload
            downloaded_mockup_path = None
            try:
                parsed = urlparse(main_image_url)
                base = os.path.basename(parsed.path) or "mockup.jpg"
                if not re.search(r'\.(jpe?g|png)$', base, re.IGNORECASE):
                    base = "mockup.jpg"

                tmpdir = tempfile.gettempdir()
                downloaded_mockup_path = os.path.join(tmpdir, f"{order_folder_name}__{base}")

                r = requests.get(main_image_url, timeout=20)
                r.raise_for_status()
                with open(downloaded_mockup_path, "wb") as f:
                    f.write(r.content)

                up2 = upload_to_drive_advanced(
                    file_path=downloaded_mockup_path,
                    filename=os.path.basename(downloaded_mockup_path),
                    parent_folder_id=FOLDER_ID,
                    use_date_subfolder=True,
                    order_subfolder=order_folder_name,
                    make_public_link=False,
                    return_folder_link=False,
                )
                upload_info["mockup_link"] = up2["webViewLink"]
            except Exception as de:
                _log(f"[MOCKUP][WARN] Cannot download/upload mockup: {de}")
                upload_info["mockup_link"] = None

        if job:
            job.meta["progress"] = "finished"
            job.save_meta()

        # callback (giữ tương thích key cũ 'drive_url')
        _callback(
            order_id,
            status="success",
            drive_url=upload_info["design_link"],
            message="PSD processed successfully",
            report=report
        )

        # trả về result phong phú cho /jobs/<id>
        result_out = {
            "status": "success",
            "message": "PSD processed successfully",
            "outputPath": upload_info["design_link"],
            "mockupPath": upload_info["mockup_link"],
            "folderPath": upload_info["folder_link"],
            "report": report
        }
        return result_out

    except Exception as e:
        msg = "".join(traceback.format_exception_only(type(e), e)).strip()
        _log("[EXCEPTION] " + msg)
        if job:
            job.meta["progress"] = "failed"
            job.meta["error"] = str(e)
            job.save_meta()
        _callback(order_id, status="error", drive_url=None, message=str(e), report=None)
        return {"status":"error","message":str(e)}

def _callback(order_id: str, status: str, drive_url: str | None, message: str | None,  report: dict | None):
    """Gửi kết quả về PHP theo URL hardcode."""
    if not DEFAULT_CALLBACK_URL:
        _log("[WARN] No DEFAULT_CALLBACK_URL configured; skip callback.")
        return
    job = _get_job()
    item_id = _split_item_id(order_id) if order_id else None
    payload = {
        "job_id": job.get_id() if job else None,
        "order_id": order_id,
        "item_id": item_id,
        "status": status,
        "drive_url": drive_url,
        "message": message,
        "report": report or {},
        "logs": (job.meta.get("logs") if job else []),
        "ts": int(time.time())
    }
    ok, resp = _post_json_with_retry(DEFAULT_CALLBACK_URL, payload, tries=3, delay=2)
    _log(f"[CALLBACK] sent={ok} resp={(str(resp)[:200] if resp else '')}")

# =========================
# test đơn giản
# =========================
def say_hello(name):
    _log(f"Hello {name}")
    _callback(order_id=f"TEST_{int(time.time())}", status="success", drive_url="https://example.com/demo", message=f"Hello {name}", report=None)
    return f"Hello {name}"
