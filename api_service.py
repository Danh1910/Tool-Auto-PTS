from flask import Flask, request, jsonify
import subprocess
import os
import json

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

from datetime import datetime


SCOPES = ['https://www.googleapis.com/auth/drive.file']
FOLDER_ID = "11zEsr74gEuYjPB7E2ibQd6i3LsLmFjW4"  # ID thư mục Drive bạn gửi

def _today_str_vn():
    """Trả về chuỗi ngày theo Asia/Ho_Chi_Minh dạng dd_mm_YYYY."""
    try:
        from zoneinfo import ZoneInfo  # Python 3.9+
        tz = ZoneInfo("Asia/Ho_Chi_Minh")
        now = datetime.now(tz)
    except Exception:
        now = datetime.now()
    return now.strftime("%d_%m_%Y")

def _find_or_create_drive_folder(service, parent_id: str, folder_name: str) -> str:
    """
    Tìm folder con theo tên trong parent_id. Nếu không có thì tạo mới.
    Trả về: folder_id.
    """
    # Tìm folder tên trùng, nằm trong parent, chưa bị trash
    query = (
        f"name = '{folder_name}' and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"'{parent_id}' in parents and trashed = false"
    )
    res = service.files().list(
        q=query,
        spaces='drive',
        fields='files(id, name)',
        pageSize=10
    ).execute()
    files = res.get('files', [])
    if files:
        return files[0]['id']

    # Không có -> tạo folder mới
    metadata = {
        'name': folder_name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }
    folder = service.files().create(body=metadata, fields='id').execute()
    return folder['id']

def upload_to_drive(file_path, filename):
    """Upload file JPG lên Google Drive vào subfolder ngày (dd_mm_YYYY) trong FOLDER_ID."""
    # ---- Auth ----
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    service = build('drive', 'v3', credentials=creds)

    # ---- Lấy/ tạo folder ngày ----
    date_folder_name = _today_str_vn()  # vd: "21_10_2025"
    daily_folder_id = _find_or_create_drive_folder(service, FOLDER_ID, date_folder_name)

    # ---- Upload file vào folder ngày ----
    file_metadata = {
        'name': filename,
        'parents': [daily_folder_id]   # <== điểm khác biệt quan trọng
    }
    media = MediaFileUpload(file_path, mimetype='image/jpeg')

    uploaded_file = service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id, webViewLink'
    ).execute()

    print(f"[UPLOAD] File uploaded to Drive (/{date_folder_name}): {uploaded_file['webViewLink']}")
    return uploaded_file['webViewLink']

app = Flask(__name__)

@app.route("/generate", methods=["POST"])
def generate_design():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON body received"}), 400

        # --- Lấy thông tin chính từ payload ---
        order_id = data.get("order_id")
        psd_filename = data.get("template")  # chỉ là tên file psd
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

        # --- Xây JSON hoàn chỉnh để truyền cho Photoshop ---
        final_payload = {
            "psdFilePath": psd_full_path,
            "outputFolder": output_folder,
            "outputFilename": output_filename,
            "jpgQuality": jpg_quality,
            "actions": actions
        }

        # --- Lưu file config tạm ---
        config_path = os.path.join(os.getcwd(), "psd_config.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(final_payload, f, indent=2, ensure_ascii=False)

        # >>> đường dẫn report JSON cho JSX
        result_path = os.path.join(os.getcwd(), "psd_result.json")
        log_path    = os.path.join(os.getcwd(), f"psd_result_{order_id}_debug.log")

        print(f"[INFO] Config saved to: {config_path}")
        print(f"[INFO] Report JSON will be at: {result_path}")
        print(f"[INFO] Payload sent to Photoshop:\n{json.dumps(final_payload, indent=2, ensure_ascii=False)}")

        # --- Gọi Photoshop script ---
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

        # --- Thành công ---
        output_path = os.path.join(output_folder, output_filename)
        print(f"[SUCCESS] Generated image: {output_path}")


        # Đọc report từ JSX (nếu có)
        report_data = None
        if os.path.exists(result_path):
            try:
                with open(result_path, "r", encoding="utf-8") as rf:
                    report_data = json.load(rf)
            except Exception as re:
                print("[WARN] Cannot read/parse report JSON:", re)

        # ====== QUAN TRỌNG: Quyết định có lỗi hay không, TRƯỚC khi upload ======
        def _has_missing(report: dict) -> bool:
            if not isinstance(report, dict):
                return False
            keys = (
                "missingGroupPaths",
                "missingPaths",
                "missingTextTargets",
                "missingShowLayers",
                "configErrors",  # include luôn để nhất quán
            )
            return any(report.get(k) for k in keys)

        has_config_error = bool(report_data and report_data.get("configErrors"))
        has_missing = _has_missing(report_data)

        # Nếu psdFilePath/config sai -> trả lỗi và KHÔNG upload
        if has_config_error:
            return jsonify({
                "status": "error",
                "message": "Config error: PSD file not found or invalid psdFilePath",
                "report": report_data or {},
                # tùy chọn: gửi path local nếu muốn debug
                "outputLocalPath": output_path if os.path.exists(output_path) else None
            }), 200

        # Nếu có các missing khác (groupPath/layerName/visibility...) -> KHÔNG upload
        if has_missing:
            return jsonify({
                "status": "error",
                "message": "PSD processed with missing targets (skip upload)",
                "report": report_data or {},
                "outputLocalPath": output_path if os.path.exists(output_path) else None
            }), 200

        # 👉 Chỉ upload khi KHÔNG có lỗi/missing
        if not os.path.exists(output_path):
            return jsonify({
                "status": "error",
                "message": "Output image not found (export may have failed)",
                "report": report_data or {}
            }), 200

        drive_link = upload_to_drive(output_path, output_filename)

        # Không có missing → thành công
        response_payload = {
            "status": "success",
            "message": "PSD processed successfully",
            "outputPath": drive_link,
            "report": report_data or {}
        }
        return jsonify(response_payload)

    except Exception as e:
        print(f"[EXCEPTION] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000)
